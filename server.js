const express = require("express");
const crypto = require("crypto");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const parseTorrent = require("parse-torrent");
const { Redis } = require("@upstash/redis");
const http = require("http");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

// Agentes otimizados para manter conexões ativas (Keep-Alive) e diminuir overhead de Handshake TLS
const axiosInstance = axios.create({
  timeout: 8000,
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true })
});

let redis = null;
try {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
} catch (e) {
  console.error("Erro fatal ao inicializar o Redis (verifique suas variáveis de ambiente KV_REST_API_URL e KV_REST_API_TOKEN):", e.message);
}

const memoryStore = new Map();

async function kvGet(key) {
  try {
    if (redis) {
      const value = await redis.get(key);
      if (value !== undefined && value !== null) return value;
    }
  } catch (_) {}

  const item = memoryStore.get(key);
  if (!item) return null;
  // Garbage collection manual (TTL) de memória
  if (item.expiry && Date.now() > item.expiry) {
    memoryStore.delete(key);
    return null;
  }
  return item.value;
}

async function kvSet(key, value, options = {}) {
  const expiry = options.ex ? Date.now() + options.ex * 1000 : null;
  memoryStore.set(key, { value, expiry });

  try {
    if (!redis) return;
    if (options.ex) {
      await redis.set(key, value, { ex: options.ex });
      return;
    }
    await redis.set(key, value);
  } catch (_) {}
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
const PIRATA_DOMAINS = [
  "https://www.thepiratafilmes.online",
];
const TRASH_PATTERN = /\b(CAM|CAMRIP|HDCAM|TC|HDTC|TS|HDTS|TELESYNC|TELECINE|LEGENDADO|LEGENDA|SUB|SUBS|SUBTITLE)\b/i;
const ANNOUNCE_SOURCES = [
  "tracker:udp://tracker.opentrackr.org:1337/announce",
  "tracker:udp://open.stealth.si:80/announce",
  "tracker:udp://tracker.torrent.eu.org:451/announce",
  "tracker:udp://tracker.coppersurfer.tk:6969/announce",
  "tracker:udp://tracker.leechers-paradise.org:6969/announce",
  "tracker:udp://explodie.org:6969/announce",
  "tracker:udp://tracker.dler.org:6969/announce",
  "http://tracker.bittorrent.am:80/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://9.rarbg.me:2970/announce",
  "udp://9.rarbg.to:2710/announce",
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
  const map = { B: 1, KB: 1024, KIB: 1024, MB: 1024 ** 2, MIB: 1024 ** 2, GB: 1024 ** 3, GIB: 1024 ** 3, TB: 1024 ** 4, TIB: 1024 ** 4 };

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

function getInfoHash(magnet) {
  const decoded = decodeMagnet(magnet);
  const match = decoded.match(/btih:([a-z0-9]{32,40})/i);
  if (match) return match[1].toLowerCase();

  try {
    const parsed = parseTorrent(decoded);
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
  const epRegex = new RegExp(`S0*${seasonNum}E0*${episodeNum}(?!\\d)|${seasonNum}x0*${episodeNum}(?!\\d)`, "i");

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

  const urls = TORRENT_SOURCES(infoHash);
  
  // Otimização de concorrência: tenta resolver o torrent de múltiplos providers ao mesmo tempo 
  // e pega o primeiro que responder, anulando o gargalo sequencial.
  const promises = urls.map(url =>
    axiosInstance.get(url, { responseType: "arraybuffer", timeout: 5000 })
      .then(res => parseTorrent(Buffer.from(res.data)))
  );

  try {
    const parsed = await Promise.any(promises);
    if (parsed?.files?.length) {
      const files = parsed.files.map((file, idx) => ({
        name: file.name,
        path: file.path || file.name,
        length: file.length,
        idx,
      }));
      await kvSet(cacheKey, files, { ex: 86400 });
      return files;
    }
  } catch (_) {
    // Falha em todos os mirrors
  }

  await kvSet(cacheKey, null, { ex: 3600 });
  return null;
}

function buildSeriesMatchers(seasonNum, episodeNum) {
  if (!seasonNum || !episodeNum) return { epRegex: null, packRegex: null, epRangeRegex: null };
  const s = String(seasonNum).padStart(2, "0");
  return {
    epRegex: new RegExp(`S${s}E0*${episodeNum}(?!\\d)|${seasonNum}x0*${episodeNum}(?!\\d)`, "i"),
    packRegex: new RegExp(`S${s}(?!E\\d)|Temporada\\s*0*${seasonNum}(?!\\d)|COMPLETE.*S${s}|S${s}.*COMPLETE`, "i"),
    epRangeRegex: new RegExp(`S${s}E(\\d{1,3})\\s*[-–]\\s*E?(\\d{1,3})`, "i"),
  };
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
  const isDown = await kvGet('circuit:betor');
  if (isDown) return [];

  const { epRegex, packRegex, epRangeRegex } = buildSeriesMatchers(seasonNum, episodeNum);

  try {
    const { data: html } = await axiosInstance.get(`${BETOR_BASE_URL}/imdb/${imdbId}/`, {
      timeout: 6000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const $ = cheerio.load(html);
    const torrents = [];

    $("[data-torrent-magnet-uri]").each((_, el) => {
      const providerUrl = $(el).attr("data-provider-url") || "";
      let providerLabel = "BeTor";
      try {
        if (providerUrl) {
          providerLabel = new URL(providerUrl).hostname.replace("www.", "");
        }
      } catch (e) {}

      const magnet = $(el).attr("data-torrent-magnet-uri");
      const fileName = $(el).attr("data-torrent-name") || "";
      const rawSize = $(el).attr("data-torrent-size") || "0";
      const seedersAttr = $(el).attr("data-torrent-num-seeds");
      const seeders = seedersAttr || "0";

      if (!magnet || !fileName || TRASH_PATTERN.test(fileName)) return;
      if (parseInt(seeders, 10) <= 0) return;

      let isSeasonPack = false;
      if (type === "series" && seasonNum && episodeNum) {
        const matchesEp = epRegex ? epRegex.test(fileName) : false;

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
        sourceLabel: "BeTor", providerLabel: `BeTor: ${providerLabel}`, fileName, rawSize, magnet, audio, quality, qualityScore, isSeasonPack, seeders,
      });

      if (torrent) torrents.push(torrent);
    });

    return torrents;
  } catch (err) {
    if (err.code === 'ECONNABORTED' || err.response?.status >= 500) {
      // Circuit Breaker: desabilita temporariamente se a fonte cair, reduzido para 30s
      console.warn(`[BeTor] Circuit breaker ativado! Fonte offline ou erro no servidor.`);
      await kvSet('circuit:betor', true, { ex: 30 });
    }
    return [];
  }
}

function buildMagnetFromStream(stream) {
  const hash = stream.infoHash;
  if (!hash) return null;
  const name = stream.behaviorHints?.filename || stream.name || hash;
  const trackers = (stream.sources || ANNOUNCE_SOURCES)
    .filter((s) => s.startsWith("tracker:"))
    .map((s) => `&tr=${encodeURIComponent(s.replace("tracker:", ""))}`);

  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${trackers.join("")}`;
}

function extractSeedersFromTitle(title) {
  const match = String(title || "").match(/👤\s*(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function extractFileNameFromStream(stream) {
  if (stream.behaviorHints?.filename) return stream.behaviorHints.filename;
  const firstLine = String(stream.title || stream.name || "").split("\n")[0].trim();
  return firstLine || null;
}

function extractRawSizeFromTitle(title) {
  const match = String(title || "").match(/([0-9]+(?:[.,][0-9]+)?)\s*(GB|MB)/i);
  if (!match) return 0;
  const value = parseFloat(match[1].replace(",", "."));
  const unit = match[2].toUpperCase();
  return unit === "GB" ? Math.round(value * 1024 ** 3) : Math.round(value * 1024 ** 2);
}

function processPirataBaseItem(fileName, magnet, rawSize, seeders, type, seasonNum, episodeNum, epRegex, packRegex, epRangeRegex) {
  if (!fileName || !magnet || TRASH_PATTERN.test(fileName)) return null;
  if (parseInt(seeders, 10) <= 0) return null;

  const { quality, qualityScore } = detectQuality(fileName);
  const audio = detectAudio(fileName);

  let isSeasonPack = false;
  if (type === "series" && seasonNum && episodeNum) {
    const matchesEp = epRegex ? epRegex.test(fileName) : false;
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
    if (!matchesEp && !matchesRange && !matchesPack) return null;
    if (!matchesEp && !matchesRange) isSeasonPack = true;
  }

  return buildTorrentEntry({
    sourceLabel: "ThePirataFilmes", providerLabel: "ThePirataFilmes", fileName, rawSize, magnet, audio, quality, qualityScore, isSeasonPack, seeders,
  });
}

async function scrapeThePirata(type, imdbId, seasonNum, episodeNum) {
  const isDown = await kvGet('circuit:pirata');
  if (isDown) return []; // Desabilitado dinamicamente para evitar timeout global

  const { epRegex, packRegex, epRangeRegex } = buildSeriesMatchers(seasonNum, episodeNum);
  const torrents = [];
  let success = false;

  for (const base of PIRATA_DOMAINS) {
    try {
      // 1ª Tentativa: Consulta através da API nativa descrita no Prowlarr
      const resApi = await axiosInstance.get(`${base}/api/search`, {
        params: { imdbid: imdbId },
        timeout: 2500,
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
      }).catch(() => null);

      if (resApi?.data && Array.isArray(resApi.data)) {
        success = true;
        for (const item of resApi.data) {
          const magnet = item.magnet_link || item.download;
          const fileName = item.title;
          const rawSize = parseSizeToBytes(item.size) || 0;
          const seeders = parseInt(item.seed_count, 10) || 0;
          
          const torrent = processPirataBaseItem(fileName, magnet, rawSize, seeders, type, seasonNum, episodeNum, epRegex, packRegex, epRangeRegex);
          if (torrent) torrents.push(torrent);
        }
        break; // Sucesso com a API, rompe o loop
      }

      // 2ª Tentativa: Fallback nativo Stremio Stream API (legado)
      const stremioId = (type === "series" && seasonNum && episodeNum) ? `${imdbId}:${seasonNum}:${episodeNum}` : imdbId;
      const resStream = await axiosInstance.get(`${base}/stream/${type === "series" ? "series" : "movie"}/${stremioId}.json`, {
        timeout: 2500,
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
      }).catch(() => null);

      if (resStream?.data?.streams && Array.isArray(resStream.data.streams)) {
        success = true;
        for (const stream of resStream.data.streams) {
          let magnet = stream.magnet || null;
          if (!magnet && stream.infoHash) magnet = buildMagnetFromStream(stream);

          const fileName = extractFileNameFromStream(stream);
          const rawSize = extractRawSizeFromTitle(stream.title);
          const seeders = extractSeedersFromTitle(stream.title);

          const torrent = processPirataBaseItem(fileName, magnet, rawSize, seeders, type, seasonNum, episodeNum, epRegex, packRegex, epRangeRegex);
          if (torrent) torrents.push(torrent);
        }
        break;
      }
    } catch (err) {
      // Falha transparente, tenta o próximo domínio base
    }
  }

  if (!success) {
    // Se ambos falharem, desliga o Pirata via Circuit Breaker por 30s
    console.warn(`[Pirata] Circuit breaker ativado! Fonte offline ou erro no servidor.`);
    await kvSet('circuit:pirata', true, { ex: 30 });
    return [];
  }

  return torrents;
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
  // Validação: infoHash deve ser hex de 40 caracteres
  if (!torrent.infoHash || !/^[a-f0-9]{40}$/i.test(torrent.infoHash)) {
    console.warn(`[mapTorrentToStream] infoHash inválido: ${torrent.infoHash}`);
    return null;
  }

  const packIcon = torrent.fileIdxResolved ? "📁" : "📁~";
  const sources = torrent.indexers.join(" · ") || torrent.sourceLabel || "IndexaBR";

  const sizeLine = torrent.isSeasonPack
    ? `${packIcon} 💾 ${formatSize(torrent.rawSize)} pack${torrent.epSize ? ` (📄 ${torrent.epSize}/ep)` : ''}`
    : `💾 ${formatSize(torrent.rawSize)}`;

  const title = `${torrent.fileName}\n👤 ${torrent.seeders || 0} ${sizeLine}\n⚙️ ${sources} · ${torrent.audio}`;

  const stream = {
    name: `IndexaBR\n${torrent.quality}`,
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

  // Modificado para allSettled: Independência de falhas críticas entre scrapers
  const results = await Promise.allSettled([
    scrapeBetor(type, imdbId, seasonNum, episodeNum),
    scrapeThePirata(type, imdbId, seasonNum, episodeNum),
  ]);

  const betor = results[0].status === "fulfilled" ? results[0].value : [];
  const pirata = results[1].status === "fulfilled" ? results[1].value : [];

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
const MIN_DEBRID_SEEDS = parseInt(process.env.MIN_DEBRID_SEEDS || "1", 10) || 1;
const MAX_STREAMS = parseInt(process.env.MAX_STREAMS || "10", 10) || 10;

function filterBySeeds(streams, isDebrid) {
  const minSeeds = isDebrid ? MIN_DEBRID_SEEDS : MIN_STREAM_SEEDS;
  if (minSeeds <= 0) return streams;

  return streams.filter((s) => {
    const textName = (s.name || "").toLowerCase();
    const textTitle = (s.title || "").toLowerCase();

    const isCached = isDebrid && (
      textName.includes("+") || textName.includes("⚡") || textName.includes("cached") ||
      textTitle.includes("⚡") || textTitle.includes("cached") || /\[[a-z]{2}\+\]/i.test(textName)
    );

    if (isDebrid && isCached) return true;

    const filename = (s.behaviorHints && s.behaviorHints.filename) ? String(s.behaviorHints.filename) : "";
    const seedMatch = textTitle.match(/👤\s*(\d+)/) || filename.match(/\[seeds:(\d+)\]/i);
    const seeders = seedMatch ? parseInt(seedMatch[1], 10) : 0;

    return seeders >= minSeeds;
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
  const seenHash = new Map(); // infoHash -> melhor stream
  const seenFile = new Set();
  const seenSize = new Set();
  const seenTitle = new Set();
  const seenNameBase = new Set();
  const result = [];

  for (const stream of streams || []) {
    const fullText = [stream.name, stream.title, stream.behaviorHints?.filename].filter(Boolean).join(" ");
    const hash = stream.infoHash ? stream.infoHash.toLowerCase() : null;
    const filename = stream.behaviorHints?.filename
      ? stream.behaviorHints.filename.toLowerCase().replace(/\.[^.]+$/, "") : null;
    const size = extractSize(fullText);
    const res = extractRes(fullText);
    const sizeKey = size ? `${size}_${res}` : null;
    const titleKey = normalizeTitle(fullText);
    const nameBaseKey = filename ? filename.replace(/[^a-z0-9]/gi, "").slice(0, 40) : null;

    // Se já vimos este infoHash, mescla metadados (pega o melhor de cada)
    if (hash && seenHash.has(hash)) {
      const existing = seenHash.get(hash);
      // Mesclar seeders
      const seedMatch = fullText.match(/👤\s*(\d+)/);
      if (seedMatch) {
        const newSeeders = parseInt(seedMatch[1], 10);
        const oldMatch = (existing.title || existing.name || "").match(/👤\s*(\d+)/);
        const oldSeeders = oldMatch ? parseInt(oldMatch[1], 10) : 0;
        if (newSeeders > oldSeeders) {
          existing.title = stream.title;
          existing.name = stream.name;
        }
      }
      // Mesclar indexers/sources
      if (stream.behaviorHints?.filename && !existing.behaviorHints?.filename?.includes(stream.behaviorHints.filename)) {
        existing.behaviorHints.filename += ` | ${stream.behaviorHints.filename}`;
      }
      continue;
    }

    // Pula se o nome base já foi visto (mesmo torrent, nome ligeiramente diferente)
    if (nameBaseKey && seenNameBase.has(nameBaseKey)) continue;

    if (hash && seenFile.has(filename)) continue;
    if (sizeKey && seenSize.has(sizeKey)) continue;
    if (titleKey && titleKey.length > 15 && seenTitle.has(titleKey)) continue;

    if (hash) seenHash.set(hash, stream);
    if (filename) seenFile.add(filename);
    if (nameBaseKey) seenNameBase.add(nameBaseKey);
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
  // Garantir que o baseUrl não tenha barra no final para evitar URLs duplicadas //
  const cleanBaseUrl = baseUrl.replace(/\/$/, "");
  const upstreams = [{
    name: "IndexaBR Internal",
    u: `${cleanBaseUrl}/internal/manifest.json`,
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
    if (cfg.stremthru) stores.push({ c: "st", t: cfg.stremthru });
  }

  return { upstreams, stores };
}

async function fetchUpstream(upstream, stores, type, imdb, timeoutMs, torrentOnly) {
  // SEMPRE buscar localmente primeiro, independente do debrid
  // O StremThru será usado apenas para converter os streams em links de debrid
  const localStreams = await scrapeAllSources(type, imdb);
  console.log(`[Scrape] ${type}/${imdb}: ${localStreams.length} streams encontrados`);

  // Se não tem streams ou modo torrentOnly, retorna local
  if (localStreams.length === 0 || torrentOnly || stores.length === 0) {
    return localStreams;
  }

  // FILTRA streams com seeders baixos ANTES de enviar pro StremThru
  const filteredStreams = filterBySeeds(localStreams, true);
  console.log(`[Scrape] Após filtro de seeders: ${filteredStreams.length} streams`);

  if (filteredStreams.length === 0) {
    console.log(`[StremThru] Nenhum stream com seeders suficientes para ${type}/${imdb}`);
    return [];
  }

  // Constroi o wrapper com os streams locais (não upstream)
  // O StremThru vai pegar os infoHashs e gerar links de debrid
  const wrapper = {
    // IMPORTANTE: O StremThru espera um upstream que retorne streams com infoHash
    // Usamos o internal stream endpoint do próprio addon
    upstreams: [{
      u: upstream.u // /internal/manifest.json
    }],
    stores: stores,
    cached: true // pede apenas cached
  };

  const url = `https://stremthru.stremio.ru/stremio/wrap/${encodeURIComponent(toB64(wrapper))}/stream/${type}/${imdb}.json`;

  console.log(`[StremThru] Solicitando wrap para ${type}/${imdb} com ${stores.length} store(s)`);
  console.log(`[StremThru] URL (primeiros 100 chars): ${url.substring(0, 100)}...`);

  try {
    const { data } = await axiosInstance.get(url, {
      timeout: timeoutMs,
      headers: { "User-Agent": "IndexaBRAddon/2.0" },
    });
    const count = data.streams?.length || 0;
    console.log(`[StremThru] ${type}/${imdb}: ${count} streams recebidos`);
    return data.streams || [];
  } catch (err) {
    if (err.response) {
      console.error(`[StremThru] ${type}/${imdb} falhou: ${err.response.status} - ${err.response.data?.error || err.message}`);
    } else {
      console.error(`[StremThru] ${type}/${imdb} falhou: ${err.message}`);
    }
    // Fallback: retorna os streams locais sem debrid (torrent direto)
    console.log(`[StremThru] Fallback: retornando streams locais (${filteredStreams.length})`);
    return filteredStreams;
  }
}

app.get("/manifest.json", (req, res) => {
  res.json({
    id: "community.indexabraddon",
    version: "2.0.0",
    name: "IndexaBR",
    description: "Streams brasileiros via scraping interno de BeTor e ThePirataFilmes, com suporte a debrid e torrent direto.",
    logo: `${resolveBaseUrl(req)}/indexabr.svg`,
    types: ["movie", "series"],
    resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: true },
  });
});

app.get("/internal/manifest.json", (req, res) => {
  res.json({
    id: "community.indexabr.internal",
    version: "2.0.0",
    name: "IndexaBR Internal",
    description: "Upstream interno do IndexaBR",
    types: ["movie", "series"],
    resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
    catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false },
  });
});

app.get("/internal/stream/:type/:id.json", async (req, res) => {
  try {
    const streams = await scrapeAllSources(req.params.type, decodeURIComponent(req.params.id));
    res.set("Cache-Control", "public, max-age=60, s-maxage=300");
    res.json({ streams: streams.slice(0, MAX_STREAMS) });
  } catch (err) {
    console.error(`[Internal] ${req.params.id}: ${err.message}`);
    res.json({ streams: [] });
  }
});

app.get("/:id/manifest.json", async (req, res) => {
  try {
    let cfg;
    if (process.env.API_KEY && req.params.id === process.env.API_KEY) {
      cfg = { torrentOnly: true };
    } else {
      cfg = await kvGet(`addon:${req.params.id}`);
    }
    if (!cfg) return res.status(404).json({ error: "Manifest não encontrado" });

    const modeLabel = cfg.torrentOnly ? " · Torrent Direto" : " · Debrid";

    res.json({
      id: `indexabr-addon-${req.params.id}`,
      version: "2.0.0",
      name: `IndexaBR${modeLabel}`,
      description: `Streams brasileiros via BeTor e ThePirataFilmes${cfg.torrentOnly ? " (modo torrent direto)" : " com debrid"}`,
      logo: `${resolveBaseUrl(req)}/indexabr.svg`,
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
      catalogs: [],
      behaviorHints: { configurable: true, configurationRequired: false },
    });
  } catch (err) {
    console.error("Manifest error:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

app.get("/:id/stream/:type/:imdb.json", async (req, res) => {
  try {
    const { id, type, imdb } = req.params;
    console.log(`[Stremio] Iniciando busca para: type=${type} imdb=${imdb} id=${id}`);
    let cfg;
    if (process.env.API_KEY && id === process.env.API_KEY) {
      cfg = { torrentOnly: true };
    } else {
      cfg = await kvGet(`addon:${id}`);
    }
    if (!cfg) return res.json({ streams: [] });

    const cacheKey = `cache:v4:${id}:${type}:${imdb}`;
    const forceRefresh = req.query.nocache === "1";
    const cached = forceRefresh ? null : await kvGet(cacheKey);
    if (cached) {
      console.log(`📦 [Stremio] Retornando do cache: ${imdb}`);
      return res.json(cached);
    }

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

      // Tempo de segurança ajustado p/ respeitar o limite padrão de execuções Vercel (10s)
      const globalTimer = setTimeout(done, 9500);

      upstreams.forEach((upstream) => {
        fetchUpstream(upstream, stores, type, imdb, 9000, torrentOnly)
          .then((streams) => accumulated.push(...streams))
          .finally(() => {
            finished += 1;
            if (finished === total) done();
          });
      });
    });

    const response = {
      streams: filterBySeeds(dedupeStreams(sortStreams(filterTrash(fastResult))), !torrentOnly).slice(0, MAX_STREAMS),
    };

    res.json(response);

    (async () => {
      try {
        const results = await Promise.allSettled(
          upstreams.map((upstream) => fetchUpstream(upstream, stores, type, imdb, 12000, torrentOnly))
        );

        const allStreams = results
          .filter((result) => result.status === "fulfilled")
          .flatMap((result) => result.value)
          .filter(Boolean);

        const payload = {
          streams: filterBySeeds(dedupeStreams(sortStreams(filterTrash(allStreams))), !torrentOnly).slice(0, MAX_STREAMS),
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

// --- Torznab (Prowlarr) Endpoint ---
function escapeXml(unsafe) {
    if (!unsafe) return '';
    return unsafe.toString().replace(/[<>&'"]/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
}

function buildCaps() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server version="1.0" title="IndexaBR Prowlarr" />
  <searching>
    <search available="yes" supportedParams="q" />
    <tv-search available="yes" supportedParams="q,season,ep,imdbid" />
    <movie-search available="yes" supportedParams="q,imdbid" />
  </searching>
  <categories>
    <category id="2000" name="Movies" />
    <category id="5000" name="TV" />
  </categories>
</caps>`;
}

function parseStreamInfo(stream) {
    let sizeBytes = 1000000000;
    let seeders = 1;
    let peers = 1;

    const fullText = [stream.name, stream.title, stream.behaviorHints?.filename].filter(Boolean).join(" ");
    
    const sizeMatch = fullText.match(/([0-9]+(?:[\.,][0-9]+)?)\s*(GB|MB|KB)/i);
    if (sizeMatch) {
        const val = parseFloat(sizeMatch[1].replace(',', '.'));
        const unit = sizeMatch[2].toUpperCase();
        if (unit === 'GB') sizeBytes = val * 1024 * 1024 * 1024;
        else if (unit === 'MB') sizeBytes = val * 1024 * 1024;
        else if (unit === 'KB') sizeBytes = val * 1024;
    }

    const seederMatch = fullText.match(/(?:👤|seeds:)\s*(\d+)/i);
    if (seederMatch) {
        seeders = parseInt(seederMatch[1], 10);
        peers = seeders;
    }

    const cleanTitle = (stream.title || '').replace(/\n/g, ' ').trim();
    const prefix = stream.name ? stream.name.replace(/\n/g, ' ') : 'IndexaBR';
    const finalTitle = `${prefix} - ${cleanTitle}`;

    let link = stream.url || '';
    let isMagnet = false;
    if (stream.infoHash) {
        link = `magnet:?xt=urn:btih:${stream.infoHash}`;
        isMagnet = true;
    }

    return { sizeBytes: Math.floor(sizeBytes), seeders, peers, finalTitle, link, isMagnet };
}

function buildXmlResults(streams) {
    let items = '';
    
    streams.forEach(stream => {
        const info = parseStreamInfo(stream);
        if (!info.link) return;

        const pubDate = new Date().toUTCString();
        
        items += `
    <item>
      <title>${escapeXml(info.finalTitle)}</title>
      <guid>${escapeXml(info.link)}</guid>
      <link>${escapeXml(info.link)}</link>
      <pubDate>${pubDate}</pubDate>
      <size>${info.sizeBytes}</size>
      <category>2000</category>
      <category>5000</category>
      <enclosure url="${escapeXml(info.link)}" length="${info.sizeBytes}" type="${info.isMagnet ? 'application/x-bittorrent' : 'video/mp4'}" />
      <torznab:attr name="seeders" value="${info.seeders}" />
      <torznab:attr name="peers" value="${info.peers}" />
      <torznab:attr name="minimumratio" value="1" />
      <torznab:attr name="minimumseedtime" value="1" />
    </item>`;
    });

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>IndexaBR Prowlarr</title>
    <description>IndexaBR proxy for Prowlarr</description>
    <link>https://indexabr.vercel.app</link>
    <language>pt-BR</language>${items}
  </channel>
</rss>`;
}

async function resolveQueryToImdbId(q, typeHint) {
    try {
        const promises = [];
        if (typeHint === 'movie' || typeHint === 'search' || !typeHint) {
            promises.push(axiosInstance.get(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(q)}.json`, { timeout: 4000 }).then(r => r.data?.metas || []));
        }
        if (typeHint === 'tvsearch' || typeHint === 'series' || typeHint === 'search' || !typeHint) {
            promises.push(axiosInstance.get(`https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(q)}.json`, { timeout: 4000 }).then(r => r.data?.metas || []));
        }
        
        const results = await Promise.allSettled(promises);
        const metas = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
        if (metas.length > 0) {
            const first = metas.find(m => m.imdb_id || m.id);
            if (first) return { id: first.imdb_id || first.id, type: first.type };
        }
    } catch(err) {}
    return null;
}

app.get("/:id/prowlarr/api", async (req, res) => {
    const { t, q, imdbid, season, ep, apikey } = req.query;
    const { id } = req.params;
    
    console.log(`[Prowlarr/Torznab] Requisição recebida: t=${t} q=${q || 'N/A'} imdbid=${imdbid || 'N/A'} season=${season || 'N/A'} ep=${ep || 'N/A'}`);

    if (process.env.API_KEY && apikey !== process.env.API_KEY) {
        res.set('Content-Type', 'text/xml');
        return res.status(401).send(`<?xml version="1.0" encoding="UTF-8"?>\n<error code="100" description="Incorrect user credentials" />`);
    }

    if (t === 'caps') {
        res.set('Content-Type', 'text/xml');
        return res.send(buildCaps());
    }

    if (t === 'movie' || t === 'tvsearch' || t === 'search') {
        const cfg = await kvGet(`addon:${id}`);
        if (!cfg) {
            res.set('Content-Type', 'text/xml');
            return res.send(buildXmlResults([]));
        }

        let type = '';
        let fullId = imdbid;

        if (!fullId && q) {
            const resolved = await resolveQueryToImdbId(q, t);
            if (resolved) {
                fullId = resolved.id;
                type = resolved.type === 'series' ? 'series' : 'movie';
                if (type === 'series' && season) {
                    if (ep) fullId = `${fullId}:${season}:${ep}`;
                }
            }
        }

        if (!fullId) {
            const dummyItem = {
                name: "IndexaBR",
                title: "IndexaBR Prowlarr Test 1080p",
                behaviorHints: { filename: "IndexaBR_Test_File.mp4" },
                infoHash: "0000000000000000000000000000000000000000"
            };
            res.set('Content-Type', 'text/xml');
            return res.send(buildXmlResults(q ? [] : [dummyItem]));
        }

        if (!type) {
            if (t === 'movie' || (t === 'search' && !season)) {
                type = 'movie';
            } else if (t === 'tvsearch' || season) {
                if (!season || !ep) {
                    res.set('Content-Type', 'text/xml');
                    return res.send(buildXmlResults([]));
                }
                type = 'series';
                if (imdbid) fullId = `${imdbid}:${season}:${ep}`;
            }
        }

        const forceRefresh = req.query.nocache === "1";
        const cacheKey = `cache:v3:${id}:${type}:${fullId}`;
        const cached = forceRefresh ? null : await kvGet(cacheKey);

        if (cached && cached.streams) {
            res.set('Content-Type', 'text/xml');
            return res.send(buildXmlResults(cached.streams));
        }

        const { upstreams, stores } = buildUpstreamsAndStores(cfg, resolveBaseUrl(req));
        const torrentOnly = !!cfg.torrentOnly;

        try {
            const results = await Promise.allSettled(
                upstreams.map((upstream) => fetchUpstream(upstream, stores, type, fullId, 8500, torrentOnly))
            );

            const allStreams = results
                .filter((result) => result.status === "fulfilled")
                .flatMap((result) => result.value)
                .filter(Boolean);

            const filteredStreams = filterBySeeds(dedupeStreams(sortStreams(filterTrash(allStreams))), !torrentOnly);

            if (filteredStreams.length > 0) {
                await kvSet(cacheKey, { streams: filteredStreams }, { ex: 1800 });
            }

            res.set('Content-Type', 'text/xml');
            res.send(buildXmlResults(filteredStreams));
        } catch (err) {
            console.error(`[Prowlarr] ${fullId}: ${err.message}`);
            res.set('Content-Type', 'text/xml');
            res.send(buildXmlResults([]));
        }
        return;
    }

    res.set('Content-Type', 'text/xml');
    res.send(buildCaps());
});
// -----------------------------------

app.get(["/", "/configure"], (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.post("/gerar", (req, res) => {
  try {
    const { realdebrid, torbox, premiumize, debridlink, alldebrid, offcloud } = req.body;
    
    // Gerar ID único para o addon
    const addonId = crypto.randomBytes(16).toString('hex');
    
    // Salvar configuração no cache
    const config = {
      realdebrid,
      torbox,
      premiumize,
      debridlink,
      alldebrid,
      offcloud,
      torrentOnly: false,
      createdAt: Date.now()
    };
    
    kvSet(`addon:${addonId}`, config);
    
    // Retornar o ID e a URL do manifest
    res.json({
      id: addonId,
      manifestUrl: `${window.location.origin}/${addonId}/manifest.json`
    });
  } catch (err) {
    console.error("Erro ao gerar addon:", err);
    res.status(500).json({ error: "Erro ao gerar configuração" });
  }
});

module.exports = app;
