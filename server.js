
const express = require("express");
const crypto = require("crypto");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const parseTorrent = require("parse-torrent");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(cors());
app.use(express.json());

const redis = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
  ? new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    })
  : null;

const memoryStore = new Map();

async function kvGet(key) {
  try {
    if (!redis) return memoryStore.has(key) ? memoryStore.get(key) : null;
    const value = await redis.get(key);
    return value === undefined ? null : value;
  } catch (_) {
    return memoryStore.has(key) ? memoryStore.get(key) : null;
  }
}

async function kvSet(key, value, options = {}) {
  memoryStore.set(key, value);

  try {
    if (!redis) return;
    if (options.ex) {
      await redis.set(key, value, { ex: options.ex });
      return;
    }
    await redis.set(key, value);
  } catch (_) {
    // fallback em memória já foi salvo acima
  }
}

function toB64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function resolveBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  }

  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

const BETOR_BASE_URL = "https://catalogo.betor.top";
const PIRATA_ITEMS_URL = "https://www.thepiratafilmes.online";
const TRASH_PATTERN = /\b(CAM|CAMRIP|HDCAM|TC|HDTC|TS|HDTS|TELESYNC|TELECINE|LEGENDADO|LEGENDA|SUB|SUBS|SUBTITLE)\b/i;
const ANNOUNCE_SOURCES = [
  "tracker:udp://tracker.opentrackr.org:1337/announce",
  "tracker:udp://open.stealth.si:80/announce",
  "tracker:udp://tracker.torrent.eu.org:451/announce",
];

const TORRENT_SOURCES = (hash) => [
  `https://itorrents.org/torrent/${hash.toUpperCase()}.torrent`,
  `https://torrage.info/torrent.php?h=${hash.toUpperCase()}`,
];

function formatSize(bytes) {
  const value = parseInt(bytes, 10);
  if (!value || Number.isNaN(value)) return "N/A";

  return value >= 1073741824
    ? `${(value / 1073741824).toFixed(2)} GB`
    : `${(value / 1048576).toFixed(2)} MB`;
}

function parseSizeToBytes(raw) {
  if (!raw) return 0;
  if (/^\d+$/.test(String(raw).trim())) return parseInt(raw, 10);

  const normalized = String(raw)
    .replace(/,/g, ".")
    .replace(/\s+/g, " ")
    .trim();

  if (/^(n\/a|0 b)$/i.test(normalized)) return 0;

  const match = normalized.match(/([0-9]+(?:\.[0-9]+)?)\s*(B|KB|KIB|MB|MIB|GB|GIB|TB|TIB)/i);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const map = {
    B: 1,
    KB: 1024,
    KIB: 1024,
    MB: 1024 ** 2,
    MIB: 1024 ** 2,
    GB: 1024 ** 3,
    GIB: 1024 ** 3,
    TB: 1024 ** 4,
    TIB: 1024 ** 4,
  };

  return Math.round(value * (map[unit] || 1));
}

function normalizeTitle(str) {
  if (!str) return "";
  return String(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\[\(][^\]\)]*[\]\)]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function nameBase(name) {
  return normalizeTitle(name).replace(/\s+/g, "").slice(0, 40);
}

function sizesSimilar(aRaw, bRaw, pct = 3) {
  const a = parseInt(aRaw, 10) || 0;
  const b = parseInt(bRaw, 10) || 0;
  if (!a || !b) return false;
  const diff = Math.abs(a - b);
  return (diff / Math.max(a, b)) * 100 <= pct || diff <= 10 * 1024 * 1024;
}

function decodeMagnet(magnet) {
  return String(magnet || "")
    .replace(/&amp;/g, "&")
    .trim();
}

// CORRIGIDO (Bug 1): parse-torrent v11 é assíncrono — parseTorrent(magnet) retorna
// uma Promise, não um objeto. Acessar .infoHash numa Promise retorna undefined sem
// lançar erro, então o catch nunca executava e a função sempre retornava null,
// descartando 100% dos torrents em buildTorrentEntry.
// Fix: extração via regex como método primário (confiável para qualquer URI magnet),
// usando parse-torrent apenas como fallback síncrono (v10 ou anterior).
function getInfoHash(magnet) {
  const decoded = decodeMagnet(magnet);

  // Regex é suficiente para qualquer URI magnet válida e não depende de versão da lib
  const match = decoded.match(/btih:([a-z0-9]{32,40})/i);
  if (match) return match[1].toLowerCase();

  // Fallback: parse-torrent síncrono (funciona apenas em v10 e anteriores)
  try {
    const parsed = parseTorrent(decoded);
    // Garante que não é uma Promise (v11+)
    if (parsed && typeof parsed.then !== "function" && typeof parsed.infoHash === "string") {
      return parsed.infoHash.toLowerCase();
    }
  } catch (_) {}

  return null;
}

function detectAudio(fileName, fallbackLanguage) {
  const text = `${fileName || ""} ${fallbackLanguage || ""}`;

  if (/\b(dual(?:\s*audio)?|dual\.?|dual_)\b/i.test(text)) return "Dual";
  if (/\b(dublado|dubbed|dub\.?|brazilian|nacional|pt[-_. ]?br|ptbr|portuguese|portugues|português)\b/i.test(text)) return "Dublado";
  if (/\b(legendad|legendado|subbed|subtitles?|legenda)\b/i.test(text)) return "Legendado";
  if (/\b(original|english|eng)\b/i.test(text)) return "Original";
  return "Unknown";
}

function detectQuality(fileName) {
  if (/2160p|4k/i.test(fileName)) return { quality: "4K", qualityScore: 4 };
  if (/1080p|full\s*hd|fhd/i.test(fileName)) return { quality: "1080p", qualityScore: 3 };
  if (/720p|\bhd\b/i.test(fileName)) return { quality: "720p", qualityScore: 2 };
  return { quality: "SD", qualityScore: 1 };
}

function guessEpisodeCount(fileName) {
  const m1 = fileName.match(/S\d{1,2}E(\d{1,3})\s*[-–]\s*E?(\d{1,3})/i);
  if (m1) {
    const diff = parseInt(m1[2], 10) - parseInt(m1[1], 10);
    if (diff > 0) return diff + 1;
  }

  const m2 = fileName.match(/\dx(\d{2})\s*a\s*\dx(\d{2})/i);
  if (m2) {
    const diff = parseInt(m2[2], 10) - parseInt(m2[1], 10);
    if (diff > 0) return diff + 1;
  }

  return null;
}

function guessFileIdx(fileName, episodeNum) {
  const firstEpMatch = fileName.match(/S\d{1,2}E(\d{1,3})/i) || fileName.match(/\dx(\d{2,3})/i);
  const firstEp = firstEpMatch ? parseInt(firstEpMatch[1], 10) : 1;
  return Math.max(0, episodeNum - firstEp);
}

function findEpisodeIdx(files, seasonNum, episodeNum) {
  if (!files?.length) return null;

  const videoExts = /\.(mkv|mp4|avi|m4v|ts|mov|wmv)$/i;
  const epRegex = new RegExp(
    `S0*${seasonNum}E0*${episodeNum}(?!\\d)|${seasonNum}x0*${episodeNum}(?!\\d)`,
    "i"
  );

  const match = files
    .filter((file) => videoExts.test(file.name))
    .find((file) => epRegex.test(file.path) || epRegex.test(file.name));

  return match ? match.idx : null;
}

async function resolveFileList(infoHash) {
  if (!infoHash || !/^[a-f0-9]{40}$/i.test(infoHash)) return null;

  const cacheKey = `files:${infoHash}`;
  const cached = await kvGet(cacheKey);
  if (cached !== null) return cached;

  for (const url of TORRENT_SOURCES(infoHash)) {
    try {
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 40000,
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      const parsed = await parseTorrent(Buffer.from(res.data));
      if (!parsed?.files?.length) continue;

      const files = parsed.files.map((file, idx) => ({
        name: file.name,
        path: file.path || file.name,
        length: file.length,
        idx,
      }));

      await kvSet(cacheKey, files, { ex: 86400 });
      return files;
    } catch (_) {
      // tenta próxima fonte
    }
  }

  await kvSet(cacheKey, null, { ex: 3600 });
  return null;
}

// CORRIGIDO: packRegex agora exige a temporada correta (sem COMPLETE genérico),
// e epRangeRegex verifica se o episódio pedido está dentro do range do pack.
function buildSeriesMatchers(seasonNum, episodeNum) {
  if (!seasonNum || !episodeNum) return { epRegex: null, packRegex: null, epRangeRegex: null };

  const s = String(seasonNum).padStart(2, "0");

  return {
    epRegex: new RegExp(`S${s}E0*${episodeNum}(?!\\d)|${seasonNum}x0*${episodeNum}(?!\\d)`, "i"),
    // COMPLETE agora exige a temporada correta no título
    packRegex: new RegExp(
      `S${s}(?!E\\d)|Temporada\\s*0*${seasonNum}(?!\\d)|COMPLETE.*S${s}|S${s}.*COMPLETE`,
      "i"
    ),
    // Range de episódios da temporada correta (ex: S05E01-E09)
    epRangeRegex: new RegExp(`S${s}E(\\d{1,3})\\s*[-–]\\s*E?(\\d{1,3})`, "i"),
  };
}

// CORRIGIDO (Bug 2): a lógica original usava includes("f") para filmes e includes("s")
// para séries. Isso causa dois problemas:
//   • "movie" não contém "f" → filmes com tipo "movie" nunca eram encontrados
//   • "filmes" e "movies" contêm "s" → eram classificados erroneamente como séries
// Fix: comparação por palavras-chave completas via regex, cobrindo todos os valores
// comuns retornados por APIs de catálogo.
function matchesRequestedType(itemType, requestedType) {
  const normalized = String(itemType || "").toLowerCase().trim();
  if (requestedType === "series") {
    return /^(serie|series|show|tvshow|tv\b|temporada)/.test(normalized);
  }
  // filmes: "movie", "movies", "film", "filme", "filmes", "feature"
  return /^(movie|movies|film|filme|filmes|feature)/.test(normalized);
}

function buildTorrentEntry({ sourceLabel, providerLabel, fileName, rawSize, magnet, audio, quality, qualityScore, isSeasonPack, seeders }) {
  const infoHash = getInfoHash(magnet);
  if (!infoHash || !fileName) return null;

  return {
    infoHash,
    magnet: decodeMagnet(magnet),
    fileName,
    rawSize: parseInt(rawSize, 10) || 0,
    quality,
    qualityScore,
    audio,
    isSeasonPack,
    sourceLabel,
    indexers: providerLabel ? [providerLabel] : [sourceLabel],
    seeders: parseInt(seeders, 10) || 0,
    fileIdx: null,
    epSize: null,
    fileIdxResolved: false,
  };
}

async function scrapeBetor(type, imdbId, seasonNum, episodeNum) {
  const { epRegex, packRegex, epRangeRegex } = buildSeriesMatchers(seasonNum, episodeNum);

  try {
    const { data: html } = await axios.get(`${BETOR_BASE_URL}/imdb/${imdbId}/`, {
      timeout: 20000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const $ = cheerio.load(html);
    const torrents = [];

    $(".provider").each((_, providerEl) => {
      const providerLabel = $(providerEl).find(".header .name").first().text().trim() || "BeTor";

      $(providerEl)
        .find("[data-torrent-magnet-uri]")
        .each((_, el) => {
          const magnet = $(el).attr("data-torrent-magnet-uri");
          const fileName = $(el).attr("data-torrent-name") || "";
          const rawSize = $(el).attr("data-torrent-size") || "0";
          const seeders = $(el).attr("data-torrent-num-seeds") || "0";

          if (!magnet || !fileName || TRASH_PATTERN.test(fileName)) return;

          let isSeasonPack = false;
          if (type === "series" && seasonNum && episodeNum) {
            const matchesEp = epRegex ? epRegex.test(fileName) : false;

            // CORRIGIDO: verifica range de episódios (ex: S05E01-E09)
            let matchesRange = false;
            if (!matchesEp && epRangeRegex) {
              const rangeMatch = fileName.match(epRangeRegex);
              if (rangeMatch) {
                const lo = parseInt(rangeMatch[1], 10);
                const hi = parseInt(rangeMatch[2], 10);
                matchesRange = episodeNum >= lo && episodeNum <= hi;
              }
            }

            const matchesPack = packRegex ? packRegex.test(fileName) : false;
            if (!matchesEp && !matchesRange && !matchesPack) return;
            if (!matchesEp && !matchesRange) isSeasonPack = true;
          }

          const { quality, qualityScore } = detectQuality(fileName);
          const audio = detectAudio(fileName);
          const torrent = buildTorrentEntry({
            sourceLabel: "BeTor",
            providerLabel: `BeTor: ${providerLabel}`,
            fileName,
            rawSize,
            magnet,
            audio,
            quality,
            qualityScore,
            isSeasonPack,
            seeders,
          });

          if (torrent) torrents.push(torrent);
        });
    });

    return torrents;
  } catch (err) {
    if (err.response?.status === 404) return [];
    console.error(`[BeTor] ${imdbId}: ${err.message}`);
    return [];
  }
}

// CORRIGIDO (Bug 3): a versão original assumia que a API sempre retorna um array puro.
// Se a API retornar { data: [...] }, { items: [...] } ou { results: [...] }, o catalog
// ficava vazio e nenhum torrent era encontrado. Fix: tenta múltiplos formatos de resposta.
async function getPirataCatalog() {
  const cacheKey = "catalog:thepirata:v1";
  const cached = await kvGet(cacheKey);
  if (Array.isArray(cached)) return cached;

  const { data } = await axios.get(PIRATA_ITEMS_URL, {
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const items = Array.isArray(data)          ? data
    : Array.isArray(data?.items)             ? data.items
    : Array.isArray(data?.data)              ? data.data
    : Array.isArray(data?.results)           ? data.results
    : Array.isArray(data?.torrents)          ? data.torrents
    : [];

  await kvSet(cacheKey, items, { ex: 900 });
  return items;
}

function extractImdbId(imdbUrl) {
  const match = String(imdbUrl || "").match(/tt\d+/i);
  return match ? match[0].toLowerCase() : null;
}

async function scrapeThePirata(type, imdbId, seasonNum, episodeNum) {
  const { epRegex, packRegex, epRangeRegex } = buildSeriesMatchers(seasonNum, episodeNum);

  try {
    const catalog = await getPirataCatalog();
    const matchedItems = catalog.filter((item) => {
      return extractImdbId(item.imdbUrl) === imdbId.toLowerCase() && matchesRequestedType(item.type, type);
    });

    const torrents = [];

    for (const item of matchedItems) {
      for (const file of item.files || []) {
        const fileName = file.fileName || "";
        const magnet = file.magnet || "";
        if (!fileName || !magnet || TRASH_PATTERN.test(fileName)) continue;

        let isSeasonPack = false;
        if (type === "series" && seasonNum && episodeNum) {
          const matchesEp = epRegex ? epRegex.test(fileName) : false;

          // CORRIGIDO: verifica range de episódios (ex: S05E01-E09)
          let matchesRange = false;
          if (!matchesEp && epRangeRegex) {
            const rangeMatch = fileName.match(epRangeRegex);
            if (rangeMatch) {
              const lo = parseInt(rangeMatch[1], 10);
              const hi = parseInt(rangeMatch[2], 10);
              matchesRange = episodeNum >= lo && episodeNum <= hi;
            }
          }

          const matchesPack = packRegex ? packRegex.test(fileName) : false;
          if (!matchesEp && !matchesRange && !matchesPack) continue;
          if (!matchesEp && !matchesRange) isSeasonPack = true;
        }

        const rawSize = parseSizeToBytes(file.size);
        const { quality, qualityScore } = detectQuality(fileName);
        const audio = detectAudio(fileName, item.language);
        const torrent = buildTorrentEntry({
          sourceLabel: "ThePirataFilmes",
          providerLabel: "ThePirataFilmes",
          fileName,
          rawSize,
          magnet,
          audio,
          quality,
          qualityScore,
          isSeasonPack,
          seeders: file.seeders,
        });

        if (torrent) torrents.push(torrent);
      }
    }

    return torrents;
  } catch (err) {
    console.error(`[ThePirataFilmes] ${imdbId}: ${err.message}`);
    return [];
  }
}

async function resolvePackFileIndexes(torrents, seasonNum, episodeNum) {
  if (!seasonNum || !episodeNum) return torrents;

  await Promise.all(
    torrents
      .filter((torrent) => torrent.isSeasonPack)
      .map(async (torrent) => {
        const files = await resolveFileList(torrent.infoHash);
        const resolvedIdx = files ? findEpisodeIdx(files, seasonNum, episodeNum) : null;

        if (resolvedIdx !== null) {
          torrent.fileIdx = resolvedIdx;
          torrent.fileIdxResolved = true;
          const episodeFile = files.find((file) => file.idx === resolvedIdx);
          torrent.epSize = episodeFile?.length ? formatSize(episodeFile.length) : null;
          return;
        }

        torrent.fileIdx = guessFileIdx(torrent.fileName, episodeNum);
        torrent.fileIdxResolved = false;
        const episodeCount = guessEpisodeCount(torrent.fileName);
        torrent.epSize = episodeCount && torrent.rawSize
          ? `~${formatSize(torrent.rawSize / episodeCount)}`
          : null;
      })
  );

  return torrents;
}

function dedupeTorrents(torrents) {
  const merged = [];

  for (const torrent of torrents) {
    const base = nameBase(torrent.fileName);
    const found = merged.find((existing) => {
      return existing.infoHash === torrent.infoHash || (
        sizesSimilar(existing.rawSize, torrent.rawSize) &&
        (nameBase(existing.fileName).startsWith(base) || base.startsWith(nameBase(existing.fileName)))
      );
    });

    if (!found) {
      merged.push({ ...torrent });
      continue;
    }

    found.indexers = Array.from(new Set([...(found.indexers || []), ...(torrent.indexers || [])]));
    found.seeders = Math.max(found.seeders || 0, torrent.seeders || 0);
    found.isSeasonPack = found.isSeasonPack || torrent.isSeasonPack;

    if ((torrent.qualityScore || 0) > (found.qualityScore || 0)) {
      found.quality = torrent.quality;
      found.qualityScore = torrent.qualityScore;
    }

    if ((torrent.rawSize || 0) > (found.rawSize || 0)) {
      found.rawSize = torrent.rawSize;
    }

    const audioRank = { Dual: 4, Dublado: 3, Unknown: 2, Original: 1, Legendado: 0 };
    if ((audioRank[torrent.audio] || 0) > (audioRank[found.audio] || 0)) {
      found.audio = torrent.audio;
    }

    if (torrent.fileIdxResolved && !found.fileIdxResolved) {
      found.fileIdx = torrent.fileIdx;
      found.fileIdxResolved = true;
      found.epSize = torrent.epSize;
      found.infoHash = torrent.infoHash;
      found.magnet = torrent.magnet;
    }
  }

  return merged;
}

function mapTorrentToStream(torrent) {
  const packIcon = torrent.fileIdxResolved ? "📁" : "📁~";
  const sources = torrent.indexers.join(" · ") || torrent.sourceLabel || "IndexaBR";

  const sizeLine = torrent.isSeasonPack
    ? [
        torrent.epSize ? `📄 ${torrent.epSize}/ep` : "",
        `${packIcon} ${formatSize(torrent.rawSize)} pack`,
      ].filter(Boolean).join(" · ")
    : `📦 ${formatSize(torrent.rawSize)}`;

  const title = [
    torrent.fileName,
    sizeLine,
    torrent.audio,
    `🗂 ${sources}`,
    `👤 ${torrent.seeders || 0}`,
  ].filter(Boolean).join("\n");

  const stream = {
    name: `IndexaBR ${torrent.quality}`,
    title,
    infoHash: torrent.infoHash,
    sources: ANNOUNCE_SOURCES,
    behaviorHints: {
      filename: `${torrent.fileName} [seeds:${torrent.seeders || 0}]`,
    },
    _sort: (torrent.isSeasonPack ? torrent.qualityScore - 0.5 : torrent.qualityScore) + Math.min((torrent.seeders || 0) / 1000, 0.4),
  };

  if (torrent.isSeasonPack) stream.fileIdx = torrent.fileIdx;
  return stream;
}

async function scrapeAllSources(type, fullId) {
  const [imdbId, season, episode] = String(fullId || "").split(":");
  const seasonNum = season ? parseInt(season, 10) : null;
  const episodeNum = episode ? parseInt(episode, 10) : null;

  if (!/^tt\d+$/i.test(imdbId || "")) return [];

  const cacheKey = `scrape:v2:${type}:${fullId}`;
  const cached = await kvGet(cacheKey);
  if (Array.isArray(cached)) return cached;

  const [betor, pirata] = await Promise.all([
    scrapeBetor(type, imdbId, seasonNum, episodeNum),
    scrapeThePirata(type, imdbId, seasonNum, episodeNum),
  ]);

  const resolved = await resolvePackFileIndexes(dedupeTorrents([...betor, ...pirata]), seasonNum, episodeNum);
  const streams = resolved
    .map(mapTorrentToStream)
    .sort((a, b) => b._sort - a._sort)
    .map(({ _sort, ...stream }) => stream);

  await kvSet(cacheKey, streams, { ex: 1800 });
  return streams;
}

function filterTrash(streams) {
  if (!Array.isArray(streams)) return [];
  return streams.filter((stream) => {
    const text = [stream.name, stream.title, stream.behaviorHints?.filename].filter(Boolean).join(" ");
    return !TRASH_PATTERN.test(text);
  });
}

const MIN_STREAM_SEEDS = parseInt(process.env.MIN_STREAM_SEEDS || process.env.P2P_MIN_SEEDS || process.env.P2P_MIN_SEEDERS || "0", 10) || 0;

function filterBySeeds(streams, isDebrid) {
  if (MIN_STREAM_SEEDS <= 0) return streams;

  return streams.filter((s) => {
    const textName = (s.name || "").toLowerCase();
    const textTitle = (s.title || "").toLowerCase();
    
    const isCached = isDebrid && (
      textName.includes("+") || 
      textName.includes("⚡") || 
      textName.includes("cached") ||
      textTitle.includes("⚡") ||
      textTitle.includes("cached") ||
      /\[[a-z]{2}\+\]/i.test(textName)
    );

    if (isDebrid && isCached) return true;

    const filename = (s.behaviorHints && s.behaviorHints.filename) ? String(s.behaviorHints.filename) : "";
    const seedMatch = textTitle.match(/👤\s*(\d+)/) || filename.match(/\[seeds:(\d+)\]/i);
    const seeders = seedMatch ? parseInt(seedMatch[1], 10) : 0;
    
    return seeders >= MIN_STREAM_SEEDS;
  });
}

function extractSize(str) {
  if (!str) return null;
  const match = str.match(/([0-9]+(?:[\.,][0-9]+)?)\s*(GB|MB)/i);
  return match ? `${match[1].replace(',', '.')}${match[2].toUpperCase()}` : null;
}

function extractRes(str) {
  if (!str) return "UNKNOWN";
  const match = str.match(/\b(4K|2160p|1080p|FHD|720p|HD|480p|SD)\b/i);
  if (!match) return "UNKNOWN";
  const res = match[1].toUpperCase();
  if (res === "FHD") return "1080P";
  if (res === "HD") return "720P";
  if (res === "SD") return "480P";
  if (res === "4K") return "2160P";
  return res;
}

function dedupeStreams(streams) {
  const seenHash = new Set();
  const seenFile = new Set();
  const seenSize = new Set();
  const seenTitle = new Set();
  const result = [];

  for (const stream of streams || []) {
    const fullText = [stream.name, stream.title, stream.behaviorHints?.filename].filter(Boolean).join(" ");
    const hash = stream.infoHash ? stream.infoHash.toLowerCase() : null;
    const filename = stream.behaviorHints?.filename
      ? stream.behaviorHints.filename.toLowerCase().replace(/\.[^.]+$/, "")
      : null;
    const size = extractSize(fullText);
    const res = extractRes(fullText);
    const sizeKey = size ? `${size}_${res}` : null;
    const titleKey = normalizeTitle(fullText);

    if (hash && seenHash.has(hash)) continue;
    if (filename && seenFile.has(filename)) continue;
    if (sizeKey && seenSize.has(sizeKey)) continue;
    if (titleKey && titleKey.length > 15 && seenTitle.has(titleKey)) continue;

    if (hash) seenHash.add(hash);
    if (filename) seenFile.add(filename);
    if (sizeKey) seenSize.add(sizeKey);
    if (titleKey && titleKey.length > 15) seenTitle.add(titleKey);

    result.push(stream);
  }

  return result;
}

function getStreamScore(stream) {
  const text = [stream.name, stream.title].filter(Boolean).join(" ").toLowerCase();
  let audio = 1;
  if (/dual|dublado|dub\b|portuguese|pt.br/i.test(text)) audio = 2;
  if (/leg\b|legendado|legenda|subs?|subtitle/i.test(text)) audio = 0;
  return audio;
}

function sortStreams(streams) {
  return [...streams].sort((a, b) => getStreamScore(b) - getStreamScore(a));
}

function buildUpstreamsAndStores(cfg, baseUrl) {
  const upstreams = [{
    name: "IndexaBR Internal",
    u: `${baseUrl}/internal/manifest.json`,
    local: true,
  }];

  const stores = [];
  if (!cfg.torrentOnly) {
    if (cfg.realdebrid) stores.push({ c: "rd", t: cfg.realdebrid });
    if (cfg.torbox) stores.push({ c: "tb", t: cfg.torbox });
    if (cfg.premiumize) stores.push({ c: "pm", t: cfg.premiumize });
    if (cfg.debridlink) stores.push({ c: "dl", t: cfg.debridlink });
    if (cfg.alldebrid) stores.push({ c: "ad", t: cfg.alldebrid });
    if (cfg.offcloud) stores.push({ c: "oc", t: cfg.offcloud });
  }

  return { upstreams, stores };
}

async function fetchUpstream(upstream, stores, type, imdb, timeoutMs, torrentOnly) {
  if (upstream.local && (torrentOnly || stores.length === 0)) {
    return scrapeAllSources(type, imdb);
  }

  const wrapper = { upstreams: [{ u: upstream.u }], stores };
  const url = `https://stremthru.stremio.ru/stremio/wrap/${encodeURIComponent(toB64(wrapper))}/stream/${type}/${imdb}.json`;

  try {
    const { data } = await axios.get(url, {
      timeout: timeoutMs,
      headers: { "User-Agent": "IndexaBRAddon/2.0" },
    });
    return data.streams || [];
  } catch (err) {
    if (err.response) {
      console.log(`🔍 [${upstream.name}] HTTP ${err.response.status}`);
    } else {
      console.log(`🔍 [${upstream.name}] Erro: ${err.message}`);
    }
    return [];
  }
}

app.post("/gerar", async (req, res) => {
  const id = crypto.randomBytes(24).toString("hex");
  await kvSet(`addon:${id}`, req.body);
  res.json({ id });
});

app.get("/manifest.json", (req, res) => {
  res.json({
    id: "community.indexabraddon",
    version: "2.0.0",
    name: "IndexaBR",
    description: "Streams brasileiros via scraping interno de BeTor e ThePirataFilmes, com suporte a debrid e torrent direto.",
    logo: `${resolveBaseUrl(req)}/indexabr.svg`,
    types: ["movie", "series"],
    resources: [{
      name: "stream",
      types: ["movie", "series"],
      idPrefixes: ["tt"],
    }],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: true,
    },
  });
});

app.get("/internal/manifest.json", (req, res) => {
  res.json({
    id: "community.indexabr.internal",
    version: "2.0.0",
    name: "IndexaBR Internal",
    description: "Upstream interno do IndexaBR",
    types: ["movie", "series"],
    resources: [{
      name: "stream",
      types: ["movie", "series"],
      idPrefixes: ["tt"],
    }],
    catalogs: [],
    behaviorHints: {
      configurable: false,
      configurationRequired: false,
    },
  });
});

app.get("/internal/stream/:type/:id.json", async (req, res) => {
  try {
    const streams = await scrapeAllSources(req.params.type, decodeURIComponent(req.params.id));
    res.set("Cache-Control", "public, max-age=60, s-maxage=300");
    res.json({ streams });
  } catch (err) {
    console.error(`[Internal] ${req.params.id}: ${err.message}`);
    res.json({ streams: [] });
  }
});

app.get("/:id/manifest.json", async (req, res) => {
  try {
    const cfg = await kvGet(`addon:${req.params.id}`);
    if (!cfg) return res.status(404).json({ error: "Manifest não encontrado" });

    const modeLabel = cfg.torrentOnly ? " · Torrent Direto" : " · Debrid";

    res.json({
      id: `indexabr-addon-${req.params.id}`,
      version: "2.0.0",
      name: `IndexaBR${modeLabel}`,
      description: `Streams brasileiros via BeTor e ThePirataFilmes${cfg.torrentOnly ? " (modo torrent direto)" : " com debrid"}`,
      logo: `${resolveBaseUrl(req)}/indexabr.svg`,
      types: ["movie", "series"],
      resources: [{
        name: "stream",
        types: ["movie", "series"],
        idPrefixes: ["tt"],
      }],
      catalogs: [],
      behaviorHints: {
        configurable: true,
        configurationRequired: false,
      },
    });
  } catch (err) {
    console.error("Manifest error:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.get("/:id/stream/:type/:imdb.json", async (req, res) => {
  try {
    const { id, type, imdb } = req.params;
    const cfg = await kvGet(`addon:${id}`);
    if (!cfg) return res.json({ streams: [] });

    const cacheKey = `cache:v3:${id}:${type}:${imdb}`;
    const forceRefresh = req.query.nocache === "1";
    const cached = forceRefresh ? null : await kvGet(cacheKey);
    if (cached) return res.json(cached);

    const { upstreams, stores } = buildUpstreamsAndStores(cfg, resolveBaseUrl(req));
    const torrentOnly = !!cfg.torrentOnly;

    const fastResult = await new Promise((resolve) => {
      const accumulated = [];
      let finished = 0;
      let resolved = false;
      const total = upstreams.length;

      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(globalTimer);
        resolve([...accumulated]);
      };

      const globalTimer = setTimeout(done, 13000);

      upstreams.forEach((upstream) => {
        fetchUpstream(upstream, stores, type, imdb, 20000, torrentOnly)
          .then((streams) => accumulated.push(...streams))
          .finally(() => {
            finished += 1;
            if (finished === total) done();
          });
      });
    });

    const response = {
      streams: filterBySeeds(dedupeStreams(sortStreams(filterTrash(fastResult))), !torrentOnly),
    };

    res.json(response);

    (async () => {
      try {
        const results = await Promise.allSettled(
          upstreams.map((upstream) => fetchUpstream(upstream, stores, type, imdb, 50000, torrentOnly))
        );

        const allStreams = results
          .filter((result) => result.status === "fulfilled")
          .flatMap((result) => result.value)
          .filter(Boolean);

        const payload = {
          streams: filterBySeeds(dedupeStreams(sortStreams(filterTrash(allStreams))), !torrentOnly),
        };

        if (payload.streams.length > 0) {
          await kvSet(cacheKey, payload, { ex: 1800 });
        }
      } catch (err) {
        console.error(`[Background] ${imdb}: ${err.message}`);
      }
    })();
  } catch (err) {
    console.error(`🚨 ERRO 500: ${err.message}`);
    res.status(500).json({ streams: [], error: "Erro interno" });
  }
});

app.get("/:id/stream/:type/:imdb", (req, res) => {
  res.redirect(`/${req.params.id}/stream/${req.params.type}/${req.params.imdb}.json`);
});

app.get("/debug/:id/:type/:imdb", async (req, res) => {
  const cfg = await kvGet(`addon:${req.params.id}`);
  if (!cfg) return res.json({ error: "CFG não encontrada" });

  const baseUrl = resolveBaseUrl(req);
  const { upstreams, stores } = buildUpstreamsAndStores(cfg, baseUrl);

  res.json({
    mode: cfg.torrentOnly ? "torrent_direto" : "debrid",
    upstreams,
    stores: stores.map((store) => store.c),
    imdb: req.params.imdb,
    baseUrl,
  });
});

app.get(["/", "/configure"], (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

module.exports = app;
