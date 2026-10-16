// The two screens that take over the scoring screen (it opens them through state.ui.sub): the cycle
// editor (spec 6.4) and Edit rules (spec 6.4, "Changing a rule mid-match"). Both work on a copy, ask the
// engine whether the copy would stand, and change the match only through api.dispatch, so the engine
// alone decides what is allowed and this file only shows its reasons.

import { derive, applyAction, ruleChangeDiff } from './engine.js';
import { rulesPanel } from './view-setup.js';
import { swapLines } from './files.js';
import { lineupAt, playerName } from './lineup.js';
import { h } from './dom.js';
import {
  ensureStyles, fmt, teamName, isCorrect, leftRight, flagText, refusalText, STREAK_MAX, triviaFormats,
  field, select, check, numberBox,
} from './view-common.js';

// ---- Style -----------------------------------------------------------------------------------

const CSS = `
.editor { display: grid; gap: 10px; max-width: 640px; }
.editor .card { margin-bottom: 0; grid-template-columns: minmax(0, 1fr); }
.editor select, .editor input, .editor textarea { max-width: 100%; }
.erow { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.erow > select, .erow > input { flex: 1 1 96px; width: auto; min-width: 0; max-width: 100%; }
.erow > select.who { flex: 1 1 100%; }
.erow > .btn { flex: none; }
.erow > .lab { flex: 0 0 64px; font-size: 14px; }
.card > .inner { display: grid; gap: 12px; }
`;

// ---- Edit rules ------------------------------------------------------------------------------

export function renderRulesEditor(root, state, api) {
  ensureStyles('editor-style', CSS);
  const { match } = state;
  const sub = state.ui.sub;
  sub.draft ??= structuredClone(match.rules);
  const back = () => api.closeSub();

  async function review() {
    let diff;
    try {
      diff = ruleChangeDiff(match, sub.draft);
    } catch (error) {
      api.setUi({ msg: refusalText(error) });
      return;
    }
    const body = diff.length === 0
      ? ['No score changes.']
      : ['These scores change:', ...diff.map(entry => h('p', { class: 'dtext' }, h('b', {}, `${entry.label} ${fmt(entry.before)} to ${fmt(entry.after)}`)))];
    const choice = await api.ask({
      title: 'Apply these rules?', body,
      buttons: [{ label: 'Apply rules', value: 'apply', primary: true }, { label: 'Keep editing', value: 'cancel' }],
    });
    if (choice === 'apply') {
      const result = api.dispatch({ type: 'setRules', rules: sub.draft }, { sub: null });
      if (!result.ok) api.setUi({ msg: refusalText(result.error) });
    }
  }

  root.append(
    h('div', { class: 'top' }, h('h1', { tabindex: '-1' }, 'Edit rules'),
      h('div', { class: 'acts' }, h('button', { type: 'button', class: 'btn small', id: 'rules-back', onclick: back }, 'Back'))),
    h('p', { class: 'hint' }, 'The format and the questions already scored stay. You will see which scores change before anything is applied.'),
    h('p', { class: state.ui.msg ? 'msg' : 'hint' }, state.ui.msg || ''),
    h('div', { class: 'card' }, rulesPanel(sub.draft)),
    h('button', { type: 'button', class: 'btn primary', id: 'rules-review', onclick: review }, 'Review changes'));
}

// ---- Cycle editor (spec 6.4) -----------------------------------------------------------------

const CTRL_MARKS = [['', 'Not marked'], ['got', 'Got'], ['missed', 'Missed']];

// Keeps a draft cycle consistent as it is edited: a set exists only for a correct starter that
// carries one, and the other team's mark exists only on a missed part when bounce-backs are on.
function tidy(draft, rules) {
  const answered = draft.buzzes.some(isCorrect);
  const carries = answered && !draft.noBonus && rules.bonus.parts > 0;
  if (!carries) draft.bonus = null;
  else if (!draft.bonus) {
    draft.bonus = { parts: Array.from({ length: rules.bonus.parts }, () => ({ ctrl: null, other: null })), total: null, passedRest: false };
  }
  for (const part of draft.bonus?.parts ?? []) if (!(rules.bonus.bounce != null && part.ctrl === 'missed')) part.other = null;
  if (draft.format === 'jackpot') for (const buzz of draft.buzzes) buzz.clue ??= draft.clue;
}

// The edited cycle checked by the engine on a copy of the match: its refusal, or the match as it
// would stand, with derive() of that (the scores, and the flags on this and later cycles).
function previewOf(match, cycleId, draft) {
  if (draft.dead && draft.buzzes.some(isCorrect)) {
    return { error: 'This question is marked dead, so a correct answer cannot be saved on it. Untick Dead first.' };
  }
  try {
    const next = applyAction(match, { type: 'replaceCycle', cycleId, cycle: structuredClone(draft) }, Date.now());
    return { d: derive(next) };
  } catch (error) {
    return { error: refusalText(error) };
  }
}

export function renderCycleEditor(root, state, api) {
  ensureStyles('editor-style', CSS);
  const { match } = state;
  const { rules } = match;
  const sub = state.ui.sub;
  const cycleId = sub.cycleId;
  const index = match.cycles.findIndex(x => x.id === cycleId);
  const saved = match.cycles[index];
  sub.draft ??= structuredClone(saved);
  const draft = sub.draft;
  const d = derive(match);
  const number = index + 1;
  const [left, right] = leftRight(match);
  const redraw = () => { tidy(draft, rules); api.setUi({}); };
  // Leaving the editor goes back to where it was opened from: the scoring screen, or the screen the
  // scoresheet named (sub.returnTo).
  const back = () => api.closeSub();
  const finished = result => {
    if (!result.ok) return false;
    if (sub.returnTo) api.go(sub.returnTo);
    return true;
  };

  // Who sat in each seat in this question (v2 4.4): the line-up for this cycle's place, so an old question names
  // who really sat there and a later one the player swapped in. A seat nobody sat in has no name, as in version 1.
  const lineup = lineupAt(match, index);
  const seatName = (team, seat) => playerName(match, team, lineup[team][seat]);
  const seatChoices = (current = null) => {
    const options = [0, 1].flatMap(team => [0, 1, 2, 3]
      .filter(seat => seatName(team, seat) !== '' || (current && current.team === team && current.seat === seat))
      .map(seat => [`${team}:${seat}`, `${teamName(match, team)}: ${seatName(team, seat) || `seat ${seat + 1}`}`]));
    return options;
  };
  const firstFree = used => {
    const team = [0, 1].find(t => !used.includes(t)) ?? 0;
    return { team, seat: [0, 1, 2, 3].find(seat => seatName(team, seat) !== '') ?? 0 };
  };
  const seatSelect = (entry, label) => select(seatChoices(entry), `${entry.team}:${entry.seat}`, value => {
    [entry.team, entry.seat] = value.split(':').map(Number);
    redraw();
  }, { 'aria-label': label, class: 'who' });

  // Starter: type or format, buzzes, Streak turns, lost turns.
  const starter = [h('h2', {}, 'Starter')];
  if (rules.starterTypes.on) {
    starter.push(field('Starter type', select([['normal', 'Normal'], ['picture', 'Picture'], ['music', 'Music']], draft.type, v => { draft.type = v; redraw(); }, { id: 'ed-type' })));
  }
  if (rules.trivia) {
    starter.push(field('Format', select(triviaFormats(rules), draft.format, v => { draft.format = v; redraw(); }, { id: 'ed-format' })));
    if (draft.format === 'jackpot') {
      starter.push(field('Clue the question reached', select(rules.trivia.jackpot.map((points, i) => [i, `Clue ${i + 1} (${points})`]), draft.clue, v => { draft.clue = Number(v); redraw(); })));
    }
    if (draft.format === 'split') {
      draft.eligible ??= [[], []];
      starter.push(...[0, 1].map(team => h('fieldset', { class: 'splitset' }, h('legend', {}, `${teamName(match, team)}: on this set`),
        [0, 1, 2, 3].map(seat => check(seatName(team, seat) || `Seat ${seat + 1} (empty)`, draft.eligible[team].includes(seat), on => {
          draft.eligible[team] = on ? [...draft.eligible[team], seat].sort() : draft.eligible[team].filter(s => s !== seat);
          redraw();
        }, { disabled: seatName(team, seat) === '' })))));
    }
  }
  const resultOptions = [...(rules.tossup.power != null ? [['power', `Power ${rules.tossup.power}`]] : []), ['ten', String(rules.tossup.ten)], ['neg', 'Neg'], ['wrong', 'Wrong']];
  starter.push(h('b', {}, 'Buzzes, in order'));
  draft.buzzes.forEach((buzz, i) => starter.push(h('div', { class: 'erow', 'data-buzz': i },
    seatSelect(buzz, `Buzz ${i + 1}: who`),
    select(resultOptions.some(([v]) => v === buzz.result) ? resultOptions : [...resultOptions, [buzz.result, buzz.result]], buzz.result, v => { buzz.result = v; redraw(); }, { 'aria-label': `Buzz ${i + 1}: result` }),
    draft.format === 'jackpot' && rules.trivia
      ? select(rules.trivia.jackpot.map((points, k) => [k, `Clue ${k + 1}`]), buzz.clue ?? draft.clue, v => { buzz.clue = Number(v); redraw(); }, { 'aria-label': `Buzz ${i + 1}: clue` }) : null,
    h('button', { type: 'button', class: 'btn small', onclick: () => { draft.buzzes.splice(i, 1); redraw(); } }, 'Remove'))));
  starter.push(h('button', {
    type: 'button', class: 'btn', id: 'ed-add-buzz', disabled: draft.buzzes.length >= 2,
    onclick: () => { draft.buzzes.push({ ...firstFree(draft.buzzes.map(b => b.team)), result: 'ten' }); redraw(); },
  }, 'Add a buzz'));
  if (rules.trivia && draft.format === 'streak') {
    starter.push(h('b', {}, 'Streak turns'));
    draft.streak.forEach((turn, i) => {
      // The same cap as the scoring screen's counter, so a typo cannot save 200 answers.
      const answers = numberBox(turn.answers, v => {
        turn.answers = Math.min(STREAK_MAX, Math.max(0, Math.round(v ?? 0)));
        answers.value = turn.answers;
        refresh();
      }, { min: 0, max: STREAK_MAX, 'aria-label': `Streak turn ${i + 1}: answers` });
      starter.push(h('div', { class: 'erow' },
        seatSelect(turn, `Streak turn ${i + 1}: who`), answers,
        check('Wrong or repeat', turn.wrong === true, on => { turn.wrong = on; refresh(); }),
        h('button', { type: 'button', class: 'btn small', onclick: () => { draft.streak.splice(i, 1); redraw(); } }, 'Remove')));
    });
    starter.push(h('button', {
      type: 'button', class: 'btn', disabled: draft.streak.length >= 2,
      onclick: () => { draft.streak.push({ ...firstFree(draft.streak.map(s => s.team)), answers: 0, wrong: false }); redraw(); },
    }, 'Add a Streak turn'));
  }
  starter.push(h('div', {}, [0, 1].map(team => check(`${teamName(match, team)} lost its turn`, draft.lostTurn.includes(team), on => {
    draft.lostTurn = on ? [...draft.lostTurn, team] : draft.lostTurn.filter(t => t !== team);
    redraw();
  }))));
  starter.push(check('Dead: nobody got it', draft.dead, on => { draft.dead = on; redraw(); }, { id: 'ed-dead' }));
  starter.push(h('p', { class: draft.dead && draft.buzzes.length > 0 ? 'msg' : 'hint', id: 'ed-dead-help' },
    draft.dead && draft.buzzes.length > 0
      ? 'This question has buzzes and is marked dead. Time called closes a question this way. Untick Dead before you give it a correct answer.'
      : 'Time called closes an open question as dead. To give such a question a correct answer, untick Dead first.'));
  starter.push(check('No bonus after this starter', draft.noBonus, on => { draft.noBonus = on; redraw(); }));
  if (rules.atTime !== 'finishCycle') {
    starter.push(check('A buzz in at time called may still answer', draft.allowAfterTime === true, on => { draft.allowAfterTime = on ? true : null; redraw(); }));
  }

  // Bonus.
  const bonusCard = [];
  if (draft.bonus) {
    const bonus = draft.bonus;
    const bounce = rules.bonus.bounce != null;
    bonusCard.push(h('h2', {}, 'Bonus'), h('p', { class: 'hint' }, `Marks for ${teamName(match, draft.buzzes.find(isCorrect)?.team ?? 0)}, who got the starter.${bounce ? ' A part it missed can go to the other team.' : ''}`));
    const partSelects = [];   // each part's two selects, so a typed total can clear them in place
    bonus.parts.forEach((part, i) => {
      const marks = [...CTRL_MARKS];
      if (rules.bonus.passRest || part.ctrl === 'passed') marks.push(['passed', 'Passed']);
      if (rules.atTime !== 'finishCycle' || part.ctrl === 'unheard') marks.push(['unheard', 'Cut off by time called']);
      const ctrlSelect = select(marks, part.ctrl ?? '', v => { part.ctrl = v || null; if (v) bonus.total = null; redraw(); }, { 'aria-label': `Part ${i + 1}: ${teamName(match, 0)} or ${teamName(match, 1)}, the team playing the bonus` });
      const otherSelect = bounce ? select([['', 'Other team: not marked'], ['got', 'Other team got'], ['missed', 'Other team missed']], part.other ?? '', v => { part.other = v || null; redraw(); },
        { disabled: part.ctrl !== 'missed', 'aria-label': `Part ${i + 1}: the other team` }) : null;
      partSelects.push([ctrlSelect, otherSelect]);
      bonusCard.push(h('div', { class: 'erow', 'data-part': i }, h('span', { class: 'lab' }, `Part ${i + 1}`), ctrlSelect, otherSelect));
    });
    if (!bounce) {
      // Typing a total clears the part marks in place. The editor is not rebuilt: a real mouse press
      // blurs this box, and a rebuild would replace the button under the pointer and lose the click.
      bonusCard.push(field(`Typed total instead of part marks (0 to ${bonus.parts.length * rules.bonus.partValue})`, numberBox(bonus.total, v => {
        bonus.total = v;
        if (v !== null) {
          for (const part of bonus.parts) { part.ctrl = null; part.other = null; }
          for (const [ctrlSelect, otherSelect] of partSelects) {
            ctrlSelect.value = '';
            if (otherSelect) { otherSelect.value = ''; otherSelect.disabled = true; }
          }
        }
        refresh();
      }, { min: 0, id: 'ed-total' })));
    }
    bonusCard.push(field('Bonus number, if corrected by hand', numberBox(draft.bonusNumberOverride, v => { draft.bonusNumberOverride = v; refresh(); }, { min: 1, id: 'ed-bonus-number' })));
  } else if (draft.buzzes.some(isCorrect) && draft.noBonus) {
    bonusCard.push(h('p', { class: 'hint' }, 'This starter carries no bonus.'));
  }

  const note = h('textarea', { rows: 2, maxlength: 500, 'aria-label': 'Note' });
  note.value = draft.note ?? '';
  note.addEventListener('input', () => { draft.note = note.value; });

  // The preview: the engine's answer for this draft, and what it would do to the scores and flags.
  const preview = h('div', { class: 'card', id: 'ed-preview' });
  const saveButton = h('button', { type: 'button', class: 'btn primary', id: 'ed-save' }, 'Save');
  function refresh() {
    const result = previewOf(match, cycleId, draft);
    saveButton.disabled = result.error !== undefined;
    if (result.error) {
      preview.replaceChildren(h('p', { class: 'msg', id: 'ed-error' }, result.error));
      return;
    }
    const scores = scoresOf => [left, right].map(team => `${teamName(match, team)} ${fmt(scoresOf[team])}`).join(', ');
    const lines = [h('p', { class: 'dtext', id: 'ed-scores' }, `Scores now: ${scores(d.scores)}. After this change: ${scores(result.d.scores)}.`)];
    for (const dc of result.d.cycles.slice(index)) {
      if (dc.flags.length > 0) lines.push(h('p', { class: 'msg', 'data-flag': dc.id }, `Q${dc.number}: ${dc.flags.map(flagText).join('; ')}.`));
    }
    preview.replaceChildren(...lines);
  }
  refresh();

  saveButton.addEventListener('click', () => {
    const result = api.dispatch({ type: 'replaceCycle', cycleId, cycle: structuredClone(draft) }, { sub: null });
    if (!finished(result)) preview.replaceChildren(h('p', { class: 'msg', id: 'ed-error' }, refusalText(result.error)));
  });

  const onInsert = async () => {
    const choice = await api.ask({
      title: `Insert a question before Q${number}?`,
      body: 'A new, empty question goes in here and later questions move down one. It starts as dead: open it and untick Dead to enter an answer.',
      buttons: [{ label: 'Insert', value: 'insert', primary: true }, { label: 'Cancel', value: 'cancel' }],
    });
    if (choice !== 'insert') return;
    const result = api.dispatch({ type: 'insertCycle', beforeCycleId: cycleId }, {});
    if (result.ok) api.setUi({ sub: { kind: 'cycle', cycleId: state.match.cycles[index].id, returnTo: sub.returnTo } });
    else api.setUi({ msg: refusalText(result.error) });
  };

  const onDelete = async () => {
    const markers = match.markers.filter(m => m.afterCycleId === cycleId);
    const before = index > 0 ? `Q${index}` : null;
    const quarterNumber = marker => match.markers.filter(m => m.type === 'quarter').indexOf(marker) + 1;
    // What a marker is called in the question. A quarter has its number, a timeout its team and a swap its words.
    const wordsFor = marker => {
      if (marker.type === 'quarter') return `the end of quarter ${quarterNumber(marker)}`;
      if (marker.type === 'timeout') return `the timeout for ${teamName(match, marker.team)}`;
      if (marker.type === 'sub') return `the swap ${swapLines(match).find(line => line.marker === marker)?.what ?? ''}`.trim();
      return { ended: 'the end of the match', halftime: 'halftime', timeCalled: 'the time-called mark' }[marker.type] ?? marker.type;
    };
    const body = [`Q${number} and everything entered on it will be removed. Later questions move up one and the scores are worked out again.`];
    for (const marker of markers) {
      const what = wordsFor(marker);
      if (before) body.push(`Q${number} carries ${what}. Deleting it moves ${what} back to ${before}.`);
      // A timeout was taken and a swap made, so with no earlier question each stays, now before the first one (the engine's deleteCycle).
      else if (marker.type === 'timeout' || marker.type === 'sub') body.push(`Q${number} carries ${what}. Deleting it keeps ${what}, now before the first question.`);
      else body.push(`Q${number} carries ${what}. Deleting it removes ${what}, as there is no earlier question to move it to.`);
    }
    const choice = await api.ask({
      title: `Delete Q${number}?`, body,
      buttons: [{ label: 'Delete question', value: 'delete', primary: true }, { label: 'Cancel', value: 'cancel' }],
    });
    if (choice !== 'delete') return;
    const result = api.dispatch({ type: 'deleteCycle', cycleId }, { sub: null });
    if (!finished(result)) api.setUi({ msg: refusalText(result.error) });
  };

  const current = d.cycles[index];
  root.append(
    h('div', { class: 'top' }, h('h1', { tabindex: '-1' }, `Edit Q${number}`),
      h('div', { class: 'acts' }, h('button', { type: 'button', class: 'btn small', id: 'ed-back', onclick: back }, 'Back'))),
    h('div', { class: 'editor' },
      current.flags.length > 0 ? h('p', { class: 'msg', id: 'ed-flags' }, `Q${current.number}: ${current.flags.map(flagText).join('; ')}.`) : null,
      state.ui.msg ? h('p', { class: 'msg' }, state.ui.msg) : null,
      h('div', { class: 'card' }, starter),
      bonusCard.length > 0 ? h('div', { class: 'card' }, bonusCard) : null,
      h('div', { class: 'card' }, field('Note', note)),
      preview,
      h('div', { class: 'row' }, saveButton, h('button', { type: 'button', class: 'btn', id: 'ed-cancel', onclick: back }, 'Cancel')),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', id: 'ed-insert', onclick: onInsert }, 'Insert a question before'),
        h('button', { type: 'button', class: 'btn', id: 'ed-delete', onclick: onDelete }, 'Delete this question'))));
}
