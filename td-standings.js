// The TD check page's last step, Standings and afternoon brackets (Skor 1.16.0, SPEC-partB 7.6): shown once the tournament
// file has an afternoon of slots and game files are read. It ranks each pool by the TD's tie rule, puts the ties across a
// bracket line first, asks the TD to choose where teams are level on both, fills the afternoon's places, lets the TD swap
// two teams, and hands out the afternoon link (7.5), the tournament file with the afternoon filled, the standings as text,
// and Print. Every rule and line is in standings.js; this file only draws them. Names go in as text only.
//
// The link is made as soon as the afternoon is complete, so Copy and Share hand it over inside their own click, as iPhone
// Safari requires (Send match does the same). Its time is when it was made, and a change remakes it later.

import { h } from './dom.js';
import { copyText } from './view-common.js';
import { offerFile } from './files.js';
import { linkBase } from './link.js';
import { afternoonPayload, scheduleLink, madeAt, NOT_PLACED } from './schedule-link.js';
import { withSchedule, scheduleFileName } from './schedule.js';
import {
  standings, RULES, DEFAULT_RULE, ruleOf, ruleLines, CARRY_OVER, standingsText, afternoonGrid, gamesText, goesText, ppbText, p20Text,
  ordinal, overtimeIncludesBonuses, regulationTossups,
} from './standings.js';
import { loadTdRule, saveTdRule } from './storage.js';

const $ = id => document.getElementById(id);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const joinAnd = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const lineText = item => (Array.isArray(item.line) ? item.line : [item.line]).map(part => (typeof part === 'string' ? part : part.b)).join('');
const listOf = (items, id) => h('ul', { id }, items.map(item => h('li', {}, lineText(item))));

// The scorer's address from this page's: the folder td.html is in, where index.html is (linkBase strips only index.html).
export const scorerBase = ({ origin, pathname }) => linkBase({ origin, pathname: pathname.replace(/[^/]*$/, '') });

// The question before a link or file made with morning games missing (7.6): `none` games with no file, `two` with two different
// files (neither counted).
export function missingQuestion(none, two = 0) {
  const games = n => (n === 1 ? '1 morning game has' : `${n} morning games have`);
  const parts = [none ? `${games(none)} no file yet` : '', two ? `${games(two)} two different files` : ''].filter(Boolean);
  return `${parts.join(', and ')}. Make the link anyway?`;
}

// `now()` gives { tournament, text, fileName, entries }: the tournament file as read (with its schedule), its text and name,
// and the game files read (or null). Gives `refresh`, which td.js calls whenever either changes.
export function initStandings(now) {
  const root = $('standings');
  let rule = RULES.some(r => r.id === loadTdRule()) ? loadTdRule() : DEFAULT_RULE;
  let choices = {};
  let swaps = [];
  let seen = { entries: null, text: null };
  let askingFor = null;          // the action waiting on "Make the link anyway?"
  let confirmed = false;         // the TD has said yes to it for these files
  let made = { key: null, link: null, error: null, at: null };
  let message = { text: '', bad: false };
  let last = null;

  const say = (text, bad = false) => { message = { text, bad }; const line = $('standings-msg'); if (line) { line.textContent = text; line.className = bad ? 'msg' : 'status'; } };

  // The link for the current afternoon, made ahead so a click can hand it over at once.
  async function makeLink(result, name) {
    const key = JSON.stringify([name, [...result.placement]]);
    if (made.key === key) return;
    made = { key, link: null, error: null, at: null };
    if (!result.complete) { made.error = NOT_PLACED; return; }
    const at = new Date().toISOString();
    const payload = afternoonPayload(result.filled, name, at);
    if (!payload.ok) { made.error = payload.error; return; }
    try {
      const out = await scheduleLink(payload.payload, scorerBase(location));
      if (made.key !== key) return;   // the afternoon changed while it was made
      if (out.ok) made = { key, link: out.link, error: null, at };
      else made = { key, link: null, error: out.error, at: null };
    } catch {
      if (made.key === key) made = { key, link: null, error: 'This browser could not make the link. Save the tournament file with the afternoon filled and post that instead.', at: null };
    }
  }

  const box = () => $('standings-box');
  async function copyLink() {
    if (!made.link) return say(made.error ?? 'The link is still being made. Try again.', true);
    const target = box();
    target.value = made.link;
    if (await copyText(made.link, target)) {
      target.hidden = true;
      say(`Afternoon link copied (made ${madeAt(made.at)}, ${made.link.length.toLocaleString('en-GB')} characters). Paste it into Discord.`);
    } else say('This browser would not copy it: the link is in the box below. Select it all and copy.', true);
  }
  async function shareLink() {
    if (!made.link) return say(made.error ?? 'The link is still being made. Try again.', true);
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ url: made.link });
        return say(`Afternoon link sent (made ${madeAt(made.at)}).`);
      } catch (error) {
        if (error?.name === 'AbortError') return say('');
      }
    }
    return copyLink();
  }
  async function saveFilled() {
    const { tournament, text, fileName } = now();
    if (!last?.complete) return say(NOT_PLACED, true);
    const name = scheduleFileName(tournament?.name ?? fileName?.replace(/\.(qbj|json)$/i, ''), true);
    let saved;
    try {
      saved = await offerFile({ name, type: 'application/json', text: withSchedule(text, last.filled) });
    } catch {
      saved = { ok: false, error: 'the file could not be made' };
    }
    if (saved.ok) say(saved.method === 'share' ? `Shared ${name}.` : `Saved ${name}. Post it in Discord; scorers load it in Setup as before.`);
    else if (!saved.cancelled) say(`It could not be saved: ${saved.error}.`, true);
  }
  const ACTIONS = { copy: copyLink, share: shareLink, save: saveFilled };

  // Copy, Share and Save first ask when a morning game has no file (7.6); the answer's button does the action in its own click.
  const act = kind => () => {
    if (!last?.complete) return say(NOT_PLACED, true);
    if (askingFor !== null) { $('missing-yes')?.focus(); return undefined; }   // the question is up: a second tap does not skip it
    if (last.missing.length && !confirmed) {
      askingFor = kind;
      $('missing-ask').hidden = false;
      $('missing-yes').textContent = kind === 'save' ? 'Save it anyway' : kind === 'share' ? 'Share it anyway' : 'Copy it anyway';
      $('missing-yes').focus();
      return undefined;
    }
    return ACTIONS[kind]();
  };
  const answer = yes => () => {
    const kind = askingFor;
    askingFor = null;
    $('missing-ask').hidden = true;
    if (yes && kind) {
      confirmed = true;
      const run = ACTIONS[kind];
      return run();
    }
    return undefined;
  };

  function choiceNode(choice, n) {
    const level = choice.record === '0-0' || choice.figure === '–';
    const intro = level
      ? `${choice.pool}: ${joinAnd(choice.teams)} have no game files yet. Choose their order:`
      : `${choice.pool}: ${joinAnd(choice.teams)} are level on ${choice.record} and ${choice.figure} ${choice.figureName}. Choose the order:`;
    const picked = choices[choice.key] ?? [];
    const selects = choice.places.slice(0, -1).map((place, k) => {
      const id = `choice-${n}-${k}`;
      const where = place.slot ? `${place.slot}${place.bracket ? `, ${place.bracket}` : ''}` : 'no afternoon game';
      const select = h('select', {
        id, class: 'pick',
        onchange: event => {
          const next = [...(choices[choice.key] ?? [])];
          next[k] = event.target.value;
          choices = { ...choices, [choice.key]: next };
          refresh();
        },
      },
      h('option', { value: '' }, 'Choose a team'),
      choice.teams.map(team => h('option', { value: team, selected: picked[k] === team }, team)));
      return h('label', { class: 'pickrow', for: id }, h('span', {}, `${choice.pool}, ${ordinal(place.place)} place (${where})`), select);
    });
    return h('div', { class: 'choice' }, h('p', { class: 'status' }, intro), ...selects,
      choice.given ? h('p', { class: 'hint' }, `Placed by the TD: ${choice.given.join(', ')}, in that order.`) : null);
  }

  function poolTable(pool) {
    return h('div', { class: 'tablewrap', tabindex: '0', role: 'region', 'aria-label': `${pool.name} standings; it scrolls sideways` },
      h('table', { class: 'grid standings', id: `standings-${pool.key}` },
        h('caption', { class: 'hint' }, pool.name),
        h('thead', {}, h('tr', {}, ['#', 'Team', 'Record', 'Games', 'PPB', 'Pts/20', 'Afternoon'].map((head, i) => h('th', { scope: 'col', class: i === 1 ? 'team' : null }, head)))),
        h('tbody', {}, pool.rows.map(row => h('tr', {},
          h('td', {}, row.pending ? `${row.place}=` : String(row.place)),
          h('th', { class: 'team', scope: 'row' }, row.team),
          h('td', {}, row.record),
          h('td', { class: row.played === row.scheduled ? null : 'gap' }, gamesText(row)),
          h('td', {}, ppbText(row.ppb)),
          h('td', {}, p20Text(row.pptuh)),
          h('td', { class: row.byTd || row.pending ? 'gap' : null }, goesText(row)))))));
  }

  function gridTable(result) {
    const rounds = afternoonGrid(result);
    const rooms = [...new Set(rounds.flatMap(round => round.games.map(game => game.room)))];
    return h('div', { class: 'tablewrap', tabindex: '0', role: 'region', 'aria-label': 'Afternoon games; it scrolls sideways' },
      h('table', { class: 'grid', id: 'afternoon-grid' },
        h('caption', { class: 'hint' }, 'Afternoon games'),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Round'), rooms.map(room => h('th', { scope: 'col' }, room)))),
        h('tbody', {}, rounds.map(round => h('tr', {},
          h('th', { scope: 'row' }, `R${round.round}`),
          rooms.map(room => h('td', {}, round.games.find(game => game.room === room)?.text ?? '–')))))));
  }

  function swapNode(result, tryOut) {
    const teams = result.pools.flatMap(pool => pool.rows.map(row => row.team));
    const select = id => h('select', { id, class: 'pick' }, h('option', { value: '' }, 'Choose a team'), teams.map(team => h('option', { value: team }, team)));
    const a = select('swap-a');
    const b = select('swap-b');
    const swap = () => {
      if (!a.value || !b.value || a.value === b.value) return say('Choose two different teams to swap.', true);
      if (!tryOut([...swaps, [a.value, b.value]]).swapped.has(a.value)) return say('Neither team has an afternoon place, or one is waiting for your choice above, so there is nothing to swap.', true);
      swaps = [...swaps, [a.value, b.value]];
      say(`Swapped ${a.value} and ${b.value}. Both are marked "placed by the TD".`);
      refresh();
      return undefined;
    };
    const undo = () => { swaps = []; say('Swaps undone: every team is where the rule puts it.'); refresh(); };
    return h('div', { class: 'swap noprint' },
      h('h3', {}, 'Swap two teams'),
      h('p', { class: 'hint' }, 'For a tiebreaker game played, or a team placed by hand. The two teams exchange afternoon places.'),
      h('div', { class: 'swaprow' },
        h('label', { class: 'pickrow', for: 'swap-a' }, h('span', {}, 'Team'), a),
        h('label', { class: 'pickrow', for: 'swap-b' }, h('span', {}, 'with'), b)),
      h('div', { class: 'acts' },
        h('button', { class: 'btn', type: 'button', id: 'swap', onclick: swap }, 'Swap'),
        swaps.length ? h('button', { class: 'btn', type: 'button', id: 'undo-swaps', onclick: undo }, `Undo swaps (${swaps.length})`) : null));
  }

  function refresh() {
    const { tournament, text, fileName, entries } = now();
    const schedule = tournament?.schedule;
    const games = (entries ?? []).filter(entry => entry.kind === 'game').map(entry => entry.game);
    if (!schedule || !schedule.rounds.some(round => round.playoff) || !entries) {
      root.replaceChildren();
      root.hidden = true;
      last = null;
      return;
    }
    // New files, or another tournament file: the TD's swaps no longer mean what they did, so they go (choices stay: each is
    // for one group of teams level on both, and applies only while that group is still level).
    if (seen.entries !== entries || seen.text !== text) {
      if (swaps.length && seen.entries !== null) say('Swaps undone: the standings were worked out again from the files.');
      swaps = [];
      askingFor = null;
      confirmed = false;
      seen = { entries, text };
    }
    const focused = document.activeElement?.id;
    const options = { rule, choices, overtimeIncludesBonuses: overtimeIncludesBonuses(text), regulationTossups: regulationTossups(text) };
    const result = standings(schedule, games, { ...options, swaps });
    const tryOut = trial => standings(schedule, games, { ...options, swaps: trial });
    last = result;
    const name = tournament.name ?? String(fileName ?? '').replace(/\.(qbj|json)$/i, '');
    makeLink(result, name);
    const ruleSelect = h('select', {
      id: 'tie-rule', class: 'pick',
      onchange: event => { rule = ruleOf(event.target.value).id; saveTdRule(rule); refresh(); },
    }, RULES.map(r => h('option', { value: r.id, selected: r.id === rule }, r.label)));
    const copyBox = h('textarea', { id: 'standings-box', class: 'noprint', readonly: true, hidden: true, 'aria-label': 'The link or the standings as text' });
    const copyStandings = async () => {
      const words = standingsText(result, name);
      copyBox.value = words;
      if (await copyText(words, copyBox)) { copyBox.hidden = true; say('Standings copied. Paste them into Discord.'); }
      else say('This browser would not copy them: they are in the box below. Select it all and copy.', true);
    };
    const notIn = [...result.extras, ...result.notCounted];
    const pendingCount = result.choices.filter(choice => !choice.given).length;
    root.replaceChildren(...[   // replaceChildren would write a null as the text "null"
      h('h2', { id: 'standings-title' }, 'Standings and afternoon brackets'),
      h('p', { class: 'hint' }, 'From the morning\'s game files. Nothing here changes a file: the link and the file are made only when you press their buttons.'),
      h('div', { class: 'rulepick noprint' }, h('label', { class: 'pickrow', for: 'tie-rule' }, h('span', {}, 'After the won-lost record'), ruleSelect)),
      h('div', { id: 'rule-lines' }, ruleLines(rule).map((line, i) => h('p', { class: i ? 'hint' : 'status' }, line))),
      result.ties.length ? h('section', { class: 'job', id: 'ties' }, h('h3', {}, `Ties across a bracket line (${result.ties.length})`), listOf(result.ties, 'ties-list')) : null,
      result.choices.length ? h('section', { class: 'job noprint', id: 'choices' }, h('h3', {}, pendingCount ? `Choose: level on both (${pendingCount})` : 'Chosen by the TD'), result.choices.map(choiceNode)) : null,
      result.missing.length ? h('section', { class: 'job', id: 'missing' }, h('h3', {}, `Morning games with no file counted (${result.missing.length})`), listOf(result.missing, 'missing-list')) : null,
      notIn.length ? h('section', { class: 'job', id: 'not-in' }, h('h3', {}, `Game files not in the schedule (${notIn.length})`), listOf(notIn, 'not-in-list')) : null,
      result.later ? h('p', { class: 'hint', id: 'later-line' }, `${plural(result.later, 'afternoon game file')} ${result.later === 1 ? 'is' : 'are'} not counted here.`) : null,
      h('section', { class: 'job', id: 'pools' }, h('h3', {}, 'Standings'), result.pools.map(poolTable),
        h('p', { class: 'hint' }, 'Games: "2 of 3" when a scheduled game has no file counted. PPB: points per bonus. Pts/20: points per 20 tossups heard, overtime left out, as YellowFruit works them.')),
      h('section', { class: 'job', id: 'brackets' }, h('h3', {}, 'Afternoon brackets'),
        h('ul', { id: 'brackets-list' }, result.brackets.map(bracket => h('li', {}, `${bracket.name}: ${bracket.places.map(p => `${p.slot} ${p.team ?? 'not placed yet'}`).join(', ')}`))),
        result.badSlots.length ? listOf(result.badSlots, 'bad-slots') : null,
        gridTable(result),
        h('p', { class: 'hint', id: 'carry-over' }, CARRY_OVER)),
      result.complete || swaps.length ? swapNode(result, tryOut) : null,
      h('div', { class: 'acts noprint', id: 'standings-acts' },
        h('button', { class: 'btn', type: 'button', id: 'copy-link', onclick: act('copy') }, 'Copy afternoon link'),
        h('button', { class: 'btn', type: 'button', id: 'share-link', onclick: act('share') }, 'Share'),
        h('button', { class: 'btn', type: 'button', id: 'save-filled', onclick: act('save') }, 'Save tournament file with the afternoon filled'),
        h('button', { class: 'btn', type: 'button', id: 'copy-standings', onclick: copyStandings }, 'Copy standings'),
        h('button', { class: 'btn', type: 'button', id: 'print-standings', onclick: () => window.print() }, 'Print')),
      h('div', { class: 'ask noprint', id: 'missing-ask', hidden: askingFor === null },
        h('p', { class: 'status' }, missingQuestion(result.missing.filter(m => m.kind === 'none').length, result.missing.filter(m => m.kind === 'two').length)),
        h('div', { class: 'acts' },
          h('button', { class: 'btn', type: 'button', id: 'missing-yes', onclick: answer(true) }, 'Copy it anyway'),
          h('button', { class: 'btn', type: 'button', id: 'missing-no', onclick: answer(false) }, 'Not yet'))),
      h('p', { class: message.bad ? 'msg' : 'status', id: 'standings-msg', role: 'status', 'aria-live': 'polite' }, message.text),
      copyBox].filter(Boolean));
    root.hidden = false;
    if (focused) $(focused)?.focus();
  }
  return refresh;
}
