// Teams, default lines, lock time, and feed-name → code mapping.
// Shared by the browser app and the Node standings script.

export const SEASON_LABEL = '2026–27';
export const GAMES_PER_TEAM = 82;
export const LEAGUE_GAMES = 1230;

// First tip-off: Tue Oct 20 2026, Celtics at Pistons, 3:00 PM ET (19:00 UTC).
// Picks lock 5 minutes before. The database rules hold the same default.
export const DEFAULT_LOCK_AT = Date.UTC(2026, 9, 20, 18, 55, 0); // 1792522500000

export const TEAMS = [
  { code: 'ATL', name: 'Atlanta Hawks', conf: 'East' },
  { code: 'BOS', name: 'Boston Celtics', conf: 'East' },
  { code: 'BKN', name: 'Brooklyn Nets', conf: 'East' },
  { code: 'CHA', name: 'Charlotte Hornets', conf: 'East' },
  { code: 'CHI', name: 'Chicago Bulls', conf: 'East' },
  { code: 'CLE', name: 'Cleveland Cavaliers', conf: 'East' },
  { code: 'DET', name: 'Detroit Pistons', conf: 'East' },
  { code: 'IND', name: 'Indiana Pacers', conf: 'East' },
  { code: 'MIA', name: 'Miami Heat', conf: 'East' },
  { code: 'MIL', name: 'Milwaukee Bucks', conf: 'East' },
  { code: 'NYK', name: 'New York Knicks', conf: 'East' },
  { code: 'ORL', name: 'Orlando Magic', conf: 'East' },
  { code: 'PHI', name: 'Philadelphia 76ers', conf: 'East' },
  { code: 'TOR', name: 'Toronto Raptors', conf: 'East' },
  { code: 'WAS', name: 'Washington Wizards', conf: 'East' },
  { code: 'DAL', name: 'Dallas Mavericks', conf: 'West' },
  { code: 'DEN', name: 'Denver Nuggets', conf: 'West' },
  { code: 'GSW', name: 'Golden State Warriors', conf: 'West' },
  { code: 'HOU', name: 'Houston Rockets', conf: 'West' },
  { code: 'LAC', name: 'LA Clippers', conf: 'West' },
  { code: 'LAL', name: 'Los Angeles Lakers', conf: 'West' },
  { code: 'MEM', name: 'Memphis Grizzlies', conf: 'West' },
  { code: 'MIN', name: 'Minnesota Timberwolves', conf: 'West' },
  { code: 'NOP', name: 'New Orleans Pelicans', conf: 'West' },
  { code: 'OKC', name: 'Oklahoma City Thunder', conf: 'West' },
  { code: 'PHX', name: 'Phoenix Suns', conf: 'West' },
  { code: 'POR', name: 'Portland Trail Blazers', conf: 'West' },
  { code: 'SAC', name: 'Sacramento Kings', conf: 'West' },
  { code: 'SAS', name: 'San Antonio Spurs', conf: 'West' },
  { code: 'UTA', name: 'Utah Jazz', conf: 'West' },
];

export const TEAM_BY_CODE = Object.fromEntries(TEAMS.map(t => [t.code, t]));

// Seed lines: Fanatics Sportsbook, Oct 15 2026 (NOT FanDuel; verify in admin).
export const DEFAULT_LINES = {
  ATL: 43.5, BOS: 51.5, BKN: 24.5, CHA: 39.5, CHI: 29.5, CLE: 48.5, DAL: 34.5,
  DEN: 49.5, DET: 49.5, GSW: 39.5, HOU: 48.5, IND: 44.5, LAC: 27.5, LAL: 46.5,
  MEM: 28.5, MIA: 46.5, MIL: 26.5, MIN: 48.5, NOP: 27.5, NYK: 52.5, OKC: 60.5,
  ORL: 43.5, PHI: 50.5, PHX: 40.5, POR: 43.5, SAC: 20.5, SAS: 59.5, TOR: 45.5,
  UTA: 35.5, WAS: 35.5,
};

// Every spelling we expect from feeds, normalized (lowercase, letters/digits only).
// Codes, ESPN abbreviations, full names, short names, city/nickname variants.
const ALIASES = {
  ATL: ['ATL', 'Atlanta Hawks', 'Atlanta', 'Hawks'],
  BOS: ['BOS', 'Boston Celtics', 'Boston', 'Celtics'],
  BKN: ['BKN', 'BRK', 'BK', 'Brooklyn Nets', 'Brooklyn', 'Nets'],
  CHA: ['CHA', 'CHO', 'Charlotte Hornets', 'Charlotte', 'Hornets'],
  CHI: ['CHI', 'Chicago Bulls', 'Chicago', 'Bulls'],
  CLE: ['CLE', 'Cleveland Cavaliers', 'Cleveland', 'Cavaliers', 'Cavs'],
  DET: ['DET', 'Detroit Pistons', 'Detroit', 'Pistons'],
  IND: ['IND', 'Indiana Pacers', 'Indiana', 'Pacers'],
  MIA: ['MIA', 'Miami Heat', 'Miami', 'Heat'],
  MIL: ['MIL', 'Milwaukee Bucks', 'Milwaukee', 'Bucks'],
  NYK: ['NYK', 'NY', 'New York Knicks', 'New York', 'Knicks'],
  ORL: ['ORL', 'Orlando Magic', 'Orlando', 'Magic'],
  PHI: ['PHI', 'Philadelphia 76ers', 'Philadelphia', '76ers', 'Sixers'],
  TOR: ['TOR', 'Toronto Raptors', 'Toronto', 'Raptors'],
  WAS: ['WAS', 'WSH', 'Washington Wizards', 'Washington', 'Wizards'],
  DAL: ['DAL', 'Dallas Mavericks', 'Dallas', 'Mavericks', 'Mavs'],
  DEN: ['DEN', 'Denver Nuggets', 'Denver', 'Nuggets'],
  GSW: ['GSW', 'GS', 'Golden State Warriors', 'Golden State', 'Warriors'],
  HOU: ['HOU', 'Houston Rockets', 'Houston', 'Rockets'],
  LAC: ['LAC', 'LA Clippers', 'Los Angeles Clippers', 'L.A. Clippers', 'Clippers'],
  LAL: ['LAL', 'Los Angeles Lakers', 'LA Lakers', 'L.A. Lakers', 'Lakers'],
  MEM: ['MEM', 'Memphis Grizzlies', 'Memphis', 'Grizzlies'],
  MIN: ['MIN', 'Minnesota Timberwolves', 'Minnesota', 'Timberwolves', 'Wolves'],
  NOP: ['NOP', 'NO', 'NOR', 'New Orleans Pelicans', 'New Orleans', 'Pelicans'],
  OKC: ['OKC', 'Oklahoma City Thunder', 'Oklahoma City', 'Thunder'],
  PHX: ['PHX', 'PHO', 'Phoenix Suns', 'Phoenix', 'Suns'],
  POR: ['POR', 'Portland Trail Blazers', 'Portland', 'Trail Blazers', 'Blazers'],
  SAC: ['SAC', 'Sacramento Kings', 'Sacramento', 'Kings'],
  SAS: ['SAS', 'SA', 'San Antonio Spurs', 'San Antonio', 'Spurs'],
  UTA: ['UTA', 'UTAH', 'Utah Jazz', 'Utah', 'Jazz'],
};
// Note: "Los Angeles" alone is deliberately absent (ambiguous).

export const normName = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const ALIAS_MAP = new Map();
for (const [code, list] of Object.entries(ALIASES)) {
  for (const a of list) {
    const k = normName(a);
    if (ALIAS_MAP.has(k) && ALIAS_MAP.get(k) !== code) throw new Error(`Alias clash: ${a}`);
    ALIAS_MAP.set(k, code);
  }
}

/** Map any feed spelling to our code. Throws on anything unknown. */
export function teamCode(...candidates) {
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const code = ALIAS_MAP.get(normName(c));
    if (code) return code;
  }
  throw new Error(`Unmapped team name: ${JSON.stringify(candidates)}`);
}
