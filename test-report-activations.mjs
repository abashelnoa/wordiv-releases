// Drives report-activations.gs against an in-memory Google Sheet, so the
// alert escalation can be asserted rather than hoped for. Apps Script globals
// are stubbed; the script's own code is untouched.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = new URL('./report-activations.gs', import.meta.url);

let fails = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) fails++;
};

function makeSheet(name) {
  const rows = [];
  return {
    name,
    rows,
    appendRow: (r) => rows.push(r.slice()),
    setFrozenRows: () => {},
    getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
    getRange: (row, col, _nr, _nc) => ({
      setValue: (v) => { rows[row - 1][col - 1] = v; },
      setValues: (vals) => {
        vals[0].forEach((v, i) => { rows[row - 1][col - 1 + i] = v; });
      },
    }),
  };
}

// The committed file ships ALERT_EMAIL empty on purpose (the repo is public),
// so every test supplies its own address; test 4 passes '' to check the
// off-switch.
function newContext(alertEmail = 'tester@example.com') {
  const sheets = new Map();
  const mails = [];
  const sandbox = {
    console,
    Date,
    Number,
    String,
    JSON,
    Object,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => sheets.get(n) || null,
        insertSheet: (n) => { const s = makeSheet(n); sheets.set(n, s); return s; },
      }),
    },
    MailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    ContentService: {
      createTextOutput: (t) => ({ setMimeType: () => t }),
      MimeType: { JSON: 'json' },
    },
  };
  vm.createContext(sandbox);
  let src = readFileSync(SRC, 'utf8');
  if (alertEmail !== undefined) {
    src = src.replace(/var ALERT_EMAIL = '[^']*';/, `var ALERT_EMAIL = '${alertEmail}';`);
  }
  vm.runInContext(src, sandbox);
  return { sandbox, sheets, mails };
}

function post(ctx, code, machine, version = '1.4.3') {
  const body = JSON.stringify({
    code, machine, version, started_on: '2026-09-01',
    at: new Date().toISOString(),
  });
  return ctx.sandbox.doPost({ postData: { contents: body } });
}

const CODE = 'a1b2c3d4e5f6';
const m = (i) => String(i).padStart(16, '0');

// --- 1. one tester, two machines: no email, count is right -----------------
{
  const ctx = newContext();
  post(ctx, CODE, m(1));
  post(ctx, CODE, m(2));
  const summary = ctx.sheets.get('summary').rows;
  check('two machines on one code are counted', summary[1][1] === 2);
  check('two machines raise NO alert (laptop + desktop)', ctx.mails.length === 0);

  // The same machine reporting again must not inflate the count.
  post(ctx, CODE, m(1));
  post(ctx, CODE, m(1));
  check('a repeat report does not add a machine',
        ctx.sheets.get('summary').rows[1][1] === 2);
  const act = ctx.sheets.get('activations').rows;
  check('the repeat is counted on its own row', act[1][6] === 3);
  check('one row per (code, machine)', act.length === 3);   // header + 2
}

// --- 2. escalation: alerts at 4, 8, 16 and nowhere else --------------------
{
  const ctx = newContext();
  const alertedAt = [];
  for (let i = 1; i <= 20; i++) {
    const before = ctx.mails.length;
    post(ctx, CODE, m(i));
    if (ctx.mails.length > before) alertedAt.push(i);
  }
  check(`alerts fire at 4, 8 and 16 only (got ${alertedAt.join(', ')})`,
        JSON.stringify(alertedAt) === JSON.stringify([4, 8, 16]));
  check('the subject names the code and the count',
        ctx.mails[0].subject.includes(CODE) && ctx.mails[0].subject.includes('4'));
  // The email is read in the one moment this whole feature exists for, so it
  // has to carry the next action, not just the bad news.
  check('the body gives the exact revoke command, with the code in it',
        ctx.mails[0].body.includes(`revoke_code.py ${CODE}`));
  check('the body says where the recipient is recorded',
        ctx.mails[0].body.includes('signup'));
  check('the body says how to tell which machine was first',
        ctx.mails[0].body.includes('started_on'));
  check('the body says the next alert threshold',
        ctx.mails[0].body.includes('reaches 8'));
}

// --- 3. two codes are independent -----------------------------------------
{
  const ctx = newContext();
  const OTHER = 'ffffffffffff';
  for (let i = 1; i <= 3; i++) post(ctx, CODE, m(i));
  for (let i = 1; i <= 5; i++) post(ctx, OTHER, m(100 + i));
  check('three machines on code A raise nothing', ctx.mails.length === 1);
  check('the alert is about code B', ctx.mails[0].subject.includes(OTHER));
  const rows = ctx.sheets.get('summary').rows;
  check('each code gets its own summary row', rows.length === 3);   // header + 2
}

// --- 4. the email can be switched off entirely ----------------------------
{
  const ctx = newContext('');
  for (let i = 1; i <= 12; i++) post(ctx, CODE, m(i));
  check('an empty ALERT_EMAIL sends nothing', ctx.mails.length === 0);
  check('but the sheet still counts', ctx.sheets.get('summary').rows[1][1] === 12);
}

// --- 5. junk is dropped, not stored ---------------------------------------
{
  const ctx = newContext();
  post(ctx, 'NOT-HEX', m(1));
  post(ctx, CODE, 'short');
  ctx.sandbox.doPost({ postData: { contents: 'not json' } });
  ctx.sandbox.doPost({});
  check('malformed reports create no sheet rows', !ctx.sheets.get('activations'));

  post(ctx, CODE, m(1));
  check('a good report after junk still lands',
        ctx.sheets.get('activations').rows.length === 2);
}

// --- 6. the browser health check --------------------------------------------
{
  const ctx = newContext();
  const out = ctx.sandbox.doGet();
  check('doGet answers ok without exposing data',
        out.includes('"ok":true') && !out.includes(CODE));
}

console.log('');
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('all report-activations.gs checks passed');
