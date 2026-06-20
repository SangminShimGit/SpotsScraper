/**
 * Cloudflare Worker — Boat spot availability scraper.
 *
 * Cron: every 10 minutes (every-10-min cron trigger)
 * Runtime: Cloudflare Workers (HTMLRewriter, native fetch, no Node.js APIs)
 *
 * Required secrets (set via `wrangler secret put`):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SCRAPE_ENGINE_TYPES  (comma-separated engine type identifiers)
 *
 * Optional vars (wrangler.toml [vars] or secrets):
 *   DB_TABLE_TARGETS    (default: target_boats)
 *   DB_TABLE_SPOTS_LOG  (default: boat_spots_log)
 *   DB_CONFLICT_COLS    (default: landing_name,boat_name,trip_date,standardized_trip_type)
 */

import { createClient } from '@supabase/supabase-js';
import { addDays, format, isValid, parse, startOfToday } from 'date-fns';

// ─── Pure helpers (ported from spotsScraperEngine.js) ────────────────────────

function cleanPrice(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function parseTripDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const datePart = raw.trim().split(/\s+/).slice(0, 2).join(' ').replace(/(\d+)(st|nd|rd|th)/i, '$1');
  const fmts = [
    'EEE. M-d-yyyy', 'EEE. MM-dd-yyyy', 'EEE. M-d-yy', 'EEE. MM-dd-yy',
    'yyyy-MM-dd', 'EEEE, MMMM d yyyy', 'EEEE, MMM d yyyy',
    'MMM d, yyyy', 'MMMM d, yyyy', 'MMM d yyyy', 'MMMM d yyyy',
    'M/d/yyyy', 'MM/dd/yyyy',
  ];
  for (const fmt of fmts) {
    const parsed = parse(datePart, fmt, new Date());
    if (isValid(parsed)) return format(parsed, 'yyyy-MM-dd');
  }
  const isoMatch = datePart.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];
  const mdyMatch = datePart.match(/\b(\d{1,2})-(\d{1,2})-(\d{4})\b/);
  if (mdyMatch) {
    const [, month, day, year] = mdyMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return null;
}

function mapTripType(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const lower = raw.trim().toLowerCase();
  if (lower.includes('twilight')) return '1/2 Day Twilight';
  if (lower.includes('1/2') || lower.includes('half')) {
    if (lower.includes('am')) return '1/2 Day AM';
    if (lower.includes('pm')) return '1/2 Day PM';
    return '1/2 Day';
  }
  if (lower.includes('3/4')) return '3/4 Day';
  if (lower.includes('full')) return 'Full Day';
  if (lower.includes('overnight')) return 'Overnight';
  if (lower.includes('1.5 day')) return '1.5 Day';
  if (lower.includes('2 day')) return '2 Day';
  if (lower.includes('3 day')) return '3 Day';
  return raw.trim() || null;
}

function deriveStatus(spotsLeft, rawStatus) {
  const lower = (rawStatus || '').trim().toLowerCase();
  if (lower.includes('sold out') || lower.includes('full')) return 'Sold Out';
  if (spotsLeft === 0) return 'Sold Out';
  if (spotsLeft != null && spotsLeft <= 4) return 'Limited';
  return 'Open';
}

function getDateWindow() {
  const today = startOfToday();
  return {
    startIso: format(today, 'yyyy-MM-dd'),
    endIso: format(addDays(today, 5), 'yyyy-MM-dd'),
  };
}

// ─── HTMLRewriter-based HTML parser ──────────────────────────────────────────
//
// Parses the trip table structure:
//   td.scale-data
//     .trip-info > strong (boat name), br, "Trip Type", .trip-icons, hr
//     .trip-depart        (date)
//     .trip-load          (max passengers)
//     .trip-price         (price)
//     .trip-spots > span.chartered | span.font_red13 | span.font_green13

async function parseTripRows(html) {
  const rows = [];

  // Mutable cell state — safe because HTMLRewriter processes in document order
  // and td elements are never nested.
  let cell = null;

  const rewriter = new HTMLRewriter()
    // ── Cell boundary ──────────────────────────────────────────────────────
    .on('td.scale-data', {
      element(el) {
        cell = {
          rawBoatName: null,
          rawDate: '',
          rawLoad: '',
          rawPrice: '',
          rawStatus: null,
          spotsLeft: null,
          _skip: false,
          // trip-info parsing state
          _inStrong: false,
          _inIgnored: false,  // inside .trip-icons (ignore text)
          _tripInfoPart: 0,   // 0=before first <br>, 1=collecting trip type, 2=done
          _tripInfoBuf: '',
          _greenBuf: '',
        };
        el.onEndTag(() => {
          if (!cell || cell._skip) { cell = null; return; }
          const maxPassengers = parseInt(cell.rawLoad.trim(), 10);
          rows.push({
            rawBoatName: (cell.rawBoatName || '').trim() || null,
            rawDate:     cell.rawDate.trim(),
            rawTripType: cell._tripInfoBuf.trim() || null,
            spotsLeft:   cell.spotsLeft,
            maxPassengers: Number.isFinite(maxPassengers) ? maxPassengers : null,
            rawPrice:    cell.rawPrice.trim(),
            rawStatus:   cell.rawStatus,
          });
          cell = null;
        });
      }
    })

    // ── Boat name (first <strong> inside .trip-info) ───────────────────────
    .on('td.scale-data .trip-info strong', {
      element(el) {
        if (cell) { cell._inStrong = true; cell.rawBoatName = ''; }
        el.onEndTag(() => { if (cell) cell._inStrong = false; });
      },
      text(chunk) {
        if (cell && cell._inStrong && chunk.text)
          cell.rawBoatName = (cell.rawBoatName || '') + chunk.text;
      },
    })

    // ── Trip type: text after first <br>, before .trip-icons / hr ─────────
    .on('td.scale-data .trip-info br', {
      element() {
        if (cell && cell._tripInfoPart === 0) cell._tripInfoPart = 1;
      },
    })
    .on('td.scale-data .trip-info .trip-icons', {
      element(el) {
        if (cell) { cell._inIgnored = true; cell._tripInfoPart = 2; }
        el.onEndTag(() => { if (cell) cell._inIgnored = false; });
      },
    })
    .on('td.scale-data .trip-info hr', {
      element() {
        if (cell) cell._tripInfoPart = 2;
      },
    })
    // Text handler on .trip-info captures ALL descendant text — filter by state flags
    .on('td.scale-data .trip-info', {
      text(chunk) {
        if (!cell || !chunk.text) return;
        if (cell._tripInfoPart === 1 && !cell._inStrong && !cell._inIgnored)
          cell._tripInfoBuf += chunk.text;
      },
    })

    // ── Scalar fields ──────────────────────────────────────────────────────
    .on('td.scale-data .trip-depart', {
      text(chunk) { if (cell && chunk.text) cell.rawDate += chunk.text; },
    })
    .on('td.scale-data .trip-load', {
      text(chunk) { if (cell && chunk.text) cell.rawLoad += chunk.text; },
    })
    .on('td.scale-data .trip-price', {
      text(chunk) { if (cell && chunk.text) cell.rawPrice += chunk.text; },
    })

    // ── Spot availability ──────────────────────────────────────────────────
    .on('td.scale-data .trip-spots span.chartered', {
      element() { if (cell) cell._skip = true; },
    })
    .on('td.scale-data .trip-spots span.font_red13', {
      element() { if (cell) cell.spotsLeft = 0; },
      text(chunk) {
        if (cell && chunk.text) cell.rawStatus = (cell.rawStatus || '') + chunk.text;
      },
    })
    .on('td.scale-data .trip-spots span.font_green13', {
      text(chunk) {
        if (!cell || !chunk.text) return;
        cell._greenBuf += chunk.text;
        const val = parseInt(cell._greenBuf.trim(), 10);
        if (Number.isFinite(val)) cell.spotsLeft = val;
      },
    });

  // HTMLRewriter operates on Response streams — wrap the raw HTML string
  const response = new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
  await rewriter.transform(response).text();

  return rows;
}

// ─── Scrape one landing page ──────────────────────────────────────────────────

async function scrapeLanding(landingUrl, boats) {
  console.log(`[Scraper] Fetching ${landingUrl}`);

  let html;
  try {
    const res = await fetch(landingUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.error(`[Scraper] Fetch failed for ${landingUrl}:`, err.message);
    return [];
  }

  const rawRows = await parseTripRows(html);
  const window = getDateWindow();
  const results = [];

  for (const raw of rawRows) {
    if (!raw.rawDate && !raw.rawTripType && raw.spotsLeft == null && !raw.rawPrice) continue;

    const matchedBoat = boats.find(
      (b) => b.boat_name.toLowerCase() === (raw.rawBoatName || '').toLowerCase(),
    );
    if (!matchedBoat) continue;

    const tripDate = parseTripDate(raw.rawDate);
    if (!tripDate || tripDate < window.startIso || tripDate > window.endIso) continue;

    const spotsLeft = raw.spotsLeft ?? 0;
    results.push({
      landing_name:            matchedBoat.landing_name,
      boat_name:               matchedBoat.boat_name,
      trip_date:               tripDate,
      standardized_trip_type:  mapTripType(raw.rawTripType),
      spots_left:              spotsLeft,
      max_passengers:          raw.maxPassengers,
      price:                   cleanPrice(raw.rawPrice),
      status:                  deriveStatus(spotsLeft, raw.rawStatus),
      scraped_at:              new Date().toISOString(),
    });
  }

  console.log(
    `[Scraper] ${landingUrl}: ${rawRows.length} raw row(s), ` +
    `${results.length} matched (${window.startIso} → ${window.endIso})`,
  );
  return results;
}

// ─── Main orchestration ───────────────────────────────────────────────────────

async function run(env) {
  const TABLE_TARGETS   = env.DB_TABLE_TARGETS   || 'target_boats';
  const TABLE_SPOTS_LOG = env.DB_TABLE_SPOTS_LOG || 'boat_spots_log';
  const CONFLICT_COLS   = env.DB_CONFLICT_COLS   || 'landing_name,boat_name,trip_date,standardized_trip_type';
  const ENGINE_TYPES    = (env.SCRAPE_ENGINE_TYPES || '').split(',').map((s) => s.trim()).filter(Boolean);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Fetch active targets from Supabase (same source as the Node.js runner)
  const query = supabase
    .from(TABLE_TARGETS)
    .select('landing_name, boat_name, target_url, engine_type')
    .eq('is_active', true);

  if (ENGINE_TYPES.length > 0) query.in('engine_type', ENGINE_TYPES);

  const { data: targets, error: fetchError } = await query;
  if (fetchError) { console.error('[Worker] Failed to fetch targets:', fetchError.message); return; }
  if (!targets?.length) { console.warn('[Worker] No active targets found.'); return; }

  console.log(`[Worker] ${targets.length} active target(s) loaded.`);

  // Group boats by landing URL (one fetch per landing page)
  const groups = new Map();
  for (const boat of targets) {
    const arr = groups.get(boat.target_url) ?? [];
    arr.push(boat);
    groups.set(boat.target_url, arr);
  }

  const LANDING_DELAY_MS = parseInt(env.LANDING_DELAY_MS || '30000', 10);
  let totalUpserted = 0;

  // Rotate landing order each cron slot so no landing is always last.
  // slot = how many 10-min windows have elapsed since epoch.
  const slot = Math.floor(Date.now() / (10 * 60_000));
  const allUrls = [...groups.keys()];
  const offset = slot % allUrls.length;
  const urls = [...allUrls.slice(offset), ...allUrls.slice(0, offset)];

  console.log(`[Worker] Slot ${slot}, offset ${offset} — order: ${urls.map(u => new URL(u).hostname).join(', ')}`);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const rows = (await scrapeLanding(url, groups.get(url))).filter(r => r.spots_left > 0 && r.price !== null);
      if (rows.length > 0) {
        const { error: upsertError } = await supabase
          .from(TABLE_SPOTS_LOG)
          .upsert(rows, { onConflict: CONFLICT_COLS });
        if (upsertError) throw upsertError;
        totalUpserted += rows.length;
      }
    } catch (err) {
      console.error(`[Worker] Error processing ${url}:`, err.message);
    }

    // Delay between landings to avoid rate limiting (skip after last)
    if (i < urls.length - 1) {
      console.log(`[Worker] Waiting ${LANDING_DELAY_MS}ms before next landing...`);
      await new Promise((r) => setTimeout(r, LANDING_DELAY_MS));
    }
  }

  console.log(`[Worker] Done — ${totalUpserted} row(s) upserted.`);
}

// ─── Worker export ────────────────────────────────────────────────────────────

export default {
  // Cron trigger — fires every 10 minutes (configured in wrangler.toml)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  // HTTP handler — allows manual trigger via POST /run
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/run' && request.method === 'POST') {
      ctx.waitUntil(run(env));
      return new Response('Scrape started\n', { status: 202 });
    }
    return new Response('FR Scraper Worker — OK\n', { status: 200 });
  },
};
