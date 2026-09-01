/**
 * Wordiv beta — log which codes are running on how many machines.
 *
 * This is Google Apps Script. It is NOT part of the app; the app only POSTs
 * to it. It lives here so the whole distribution story sits in one repository,
 * next to signup-autoreply.gs.
 *
 * WHAT IT DOES
 *   Every Wordiv beta install reports itself: a 12-character hash prefix of
 *   the code it was activated with, and a 16-character irreversible
 *   fingerprint of the machine. This script keeps one row per (code, machine)
 *   and a summary row per code, so the question "how many machines is this
 *   code on?" has an answer you can look at.
 *
 *   Two machines on one code is a tester with a desktop and a laptop. Forty
 *   machines in two days is a code that was posted somewhere, and that is the
 *   thing this exists to make visible. When you see it, delete that one hash
 *   from beta-codes.json and push -- see "WHEN YOU SPOT A LEAK" below.
 *
 * WHAT IT DOES NOT RECEIVE
 *   Not the code itself, not a name, not an email, not an IP you can read, not
 *   a machine ID. The code arrives as a hash prefix, which YOU can match back
 *   to a tester because you hold the plaintext codes in codes-<date>.csv --
 *   nobody else can. The machine fingerprint is a salted hash and matches
 *   nothing outside this sheet. It counts; it does not identify.
 *
 * SETUP, ONCE
 *   1. Make a new Google Sheet. Name it whatever you like.
 *   2. Extensions -> Apps Script. Delete whatever is there, paste this file,
 *      Save.
 *   3. Deploy -> New deployment -> gear icon -> Web app.
 *          Description:      Wordiv activations
 *          Execute as:       Me
 *          Who has access:   Anyone            <-- REQUIRED
 *      "Anyone" is not a mistake: the app posts without a Google account, so
 *      anything narrower rejects every report. The endpoint only ever appends
 *      validated rows and never returns data, so there is nothing to read out
 *      of it. See HARDENING below if it ever gets spammed.
 *   4. Authorise when prompted (it is your own script writing to your own
 *      sheet). Google will warn that the app is unverified -- Advanced ->
 *      Go to <project> (unsafe).
 *   5. Copy the deployment's Web app URL. It looks like
 *          https://script.google.com/macros/s/AKfy.../exec
 *   6. Send that URL to your developer. It goes into REPORT_URL in
 *      smartflow/core/beta.py, and reporting is OFF until it does.
 *
 *   To check it is alive: open the /exec URL in a browser. It should answer
 *      {"ok":true,"service":"wordiv-activations"}
 *
 * YOU DO NOT HAVE TO WATCH THE SHEET
 *   Set ALERT_EMAIL below and the script emails you the moment one code
 *   crosses ALERT_THRESHOLD distinct machines. It then stays quiet until the
 *   count DOUBLES, so a code that keeps spreading escalates (4 -> 8 -> 16)
 *   without filling your inbox on the way.
 *
 *   A tester who reinstalls Windows gets a new fingerprint and legitimately
 *   counts as a new machine, so 3 is not yet news. The default threshold of 4
 *   is set with that in mind -- raise it if you find it chatty.
 *
 *   Optional: attach sendDigest() to a weekly trigger (Triggers -> Add
 *   trigger -> sendDigest -> Time-driven -> Week timer) for a "here is where
 *   everything stands" email even when nothing is wrong.
 *
 * READING THE SHEET
 *   "summary"      one row per code. Sort by `machines` descending; that top
 *                  row is the first place a leak shows up.
 *   "activations"  one row per (code, machine), with first_seen, last_seen and
 *                  how many times it has reported.
 *
 * WHEN YOU SPOT A LEAK
 *   Find the code prefix in the summary sheet, match it against your
 *   codes-<date>.csv to see whose code it was, then remove that ONE hash from
 *   beta-codes.json and push. Every machine using it is blocked at its next
 *   startup -- including the tester who leaked it, which cannot be avoided:
 *   the block is per code, not per machine.
 *
 * IF YOU EVER REDEPLOY
 *   Deploy -> Manage deployments -> edit the EXISTING deployment and bump its
 *   version. Creating a NEW deployment gives you a NEW URL, and every already
 *   installed copy keeps posting to the old one.
 *
 * HARDENING, only if it is ever abused
 *   Add a shared secret: put a constant here, have the app send it as a field,
 *   and reject anything without it. Not done by default because the secret
 *   would ship inside the app anyway, so it stops casual noise and nothing
 *   more -- and the cost of noise here is a few junk rows.
 */

// Where the leak alarm goes. FILL THIS IN INSIDE THE APPS SCRIPT EDITOR, not
// here: this repository is public, and an address committed to it is an
// address that gets scraped. Left empty, email is off and the sheet still
// records everything.
var ALERT_EMAIL = '';

// Distinct machines on ONE code before you are emailed. A tester with a
// desktop and a laptop is 2; a Windows reinstall makes that 3. 4 is the first
// count that is hard to explain innocently.
var ALERT_THRESHOLD = 4;

var ACTIVATIONS_SHEET = 'activations';
var SUMMARY_SHEET = 'summary';

// Rejected beyond this. A real beta does not have 50,000 machines, and an
// unbounded sheet is how a runaway loop turns into a Google quota problem.
var MAX_ROWS = 50000;

var ACTIVATION_HEADERS = ['code', 'machine', 'version', 'started_on',
                          'first_seen', 'last_seen', 'reports'];
// `alerted_at` remembers the machine count we last emailed about, so the next
// mail waits for the count to double instead of arriving on every report.
var SUMMARY_HEADERS = ['code', 'machines', 'first_seen', 'last_seen',
                       'versions', 'alerted_at'];


/** Browser check: confirms the deployment is live without exposing anything. */
function doGet() {
  return json({ ok: true, service: 'wordiv-activations' });
}


function doPost(e) {
  var report;
  try {
    report = parseReport(e);
  } catch (err) {
    // A malformed body is noise, not an incident. Answer 200 so the app does
    // not retry, and drop it.
    return json({ ok: false, error: String(err) });
  }

  // The app fires these from several machines at once after a release, and
  // two concurrent runs would each read-modify-write the same row.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json({ ok: false, error: 'busy' });
  }
  try {
    record(report);
    return json({ ok: true });
  } finally {
    lock.releaseLock();
  }
}


/** Validate hard: everything that reaches the sheet is a known shape. */
function parseReport(e) {
  if (!e || !e.postData || !e.postData.contents) { throw 'no body'; }
  var body = JSON.parse(e.postData.contents);

  var code = String(body.code || '');
  var machine = String(body.machine || '');
  if (!/^[0-9a-f]{12}$/.test(code)) { throw 'bad code'; }
  if (!/^[0-9a-f]{16}$/.test(machine)) { throw 'bad machine'; }

  // These three are informational, so they are trimmed rather than rejected --
  // a future app version that adds a field must not start failing here.
  var version = String(body.version || '').slice(0, 20);
  var startedOn = String(body.started_on || '').slice(0, 10);
  return {
    code: code,
    machine: machine,
    version: version,
    startedOn: startedOn,
    at: new Date()
  };
}


function record(report) {
  var sheet = sheetNamed(ACTIVATIONS_SHEET, ACTIVATION_HEADERS);
  var values = sheet.getDataRange().getValues();
  if (values.length > MAX_ROWS) { return; }

  var found = -1;
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === report.code &&
        String(values[i][1]) === report.machine) {
      found = i + 1;   // sheet rows are 1-based and row 1 is the header
      break;
    }
  }

  if (found > 0) {
    var reports = Number(values[found - 1][6]) || 0;
    sheet.getRange(found, 3).setValue(report.version);
    sheet.getRange(found, 6).setValue(report.at);
    sheet.getRange(found, 7).setValue(reports + 1);
  } else {
    sheet.appendRow([report.code, report.machine, report.version,
                     report.startedOn, report.at, report.at, 1]);
  }
  updateSummary(report.code);
}


/** Rebuild the one summary row for this code. */
function updateSummary(code) {
  var activations = sheetNamed(ACTIVATIONS_SHEET, ACTIVATION_HEADERS)
      .getDataRange().getValues();

  var machines = {};
  var versions = {};
  var first = null;
  var last = null;
  for (var i = 1; i < activations.length; i++) {
    if (String(activations[i][0]) !== code) { continue; }
    machines[String(activations[i][1])] = true;
    if (activations[i][2]) { versions[String(activations[i][2])] = true; }
    var seenFirst = activations[i][4];
    var seenLast = activations[i][5];
    if (seenFirst && (first === null || seenFirst < first)) { first = seenFirst; }
    if (seenLast && (last === null || seenLast > last)) { last = seenLast; }
  }

  var count = Object.keys(machines).length;
  var summary = sheetNamed(SUMMARY_SHEET, SUMMARY_HEADERS);
  var rows = summary.getDataRange().getValues();

  var existingRow = -1;
  var alertedAt = 0;
  for (var j = 1; j < rows.length; j++) {
    if (String(rows[j][0]) === code) {
      existingRow = j + 1;
      alertedAt = Number(rows[j][5]) || 0;
      break;
    }
  }

  // Email on the first crossing, then only when it has DOUBLED since the last
  // mail: 4 -> 8 -> 16. A code being passed around escalates on its own; one
  // that sits at five machines does not nag.
  var shouldAlert = ALERT_EMAIL &&
      count >= ALERT_THRESHOLD &&
      (alertedAt === 0 || count >= alertedAt * 2);
  if (shouldAlert) {
    if (sendAlert(code, count, first, last)) { alertedAt = count; }
  }

  var row = [code, count, first, last,
             Object.keys(versions).sort().join(', '), alertedAt];
  if (existingRow > 0) {
    summary.getRange(existingRow, 1, 1, row.length).setValues([row]);
  } else {
    summary.appendRow(row);
  }
}


/** The leak alarm. Returns false if the mail failed, so we alert again later. */
function sendAlert(code, count, first, last) {
  var subject = 'Wordiv beta: code ' + code + ' is on ' + count + ' machines';
  var body = [
    'One beta code is now active on ' + count + ' distinct machines.',
    '',
    '  code prefix : ' + code,
    '  machines    : ' + count,
    '  first seen  : ' + first,
    '  last seen   : ' + last,
    '',
    'A tester with a desktop and a laptop is 2, and a Windows reinstall can',
    'make that 3. ' + count + ' is worth a look.',
    '',
    'To find out whose code this is, search your codes-<date>.csv for the',
    'code whose SHA-256 starts with ' + code + '.',
    '',
    'To shut it down: remove that one hash from beta-codes.json and push.',
    'Every machine on that code is blocked at its next startup -- including',
    'the tester it was issued to, which cannot be avoided: the block is per',
    'code, not per machine.',
    '',
    'The next email about this code waits until it reaches ' + (count * 2) + '.'
  ].join('\n');

  try {
    MailApp.sendEmail(ALERT_EMAIL, subject, body);
    return true;
  } catch (err) {
    // Out of daily quota, or a bad address. The sheet is still correct, and
    // leaving alerted_at alone means the next report tries again.
    return false;
  }
}


/**
 * OPTIONAL weekly "where things stand" email. Attach to a time-driven trigger;
 * nothing calls it otherwise. Unlike sendAlert this always sends, so you get a
 * heartbeat that tells you the reporting itself is still working.
 */
function sendDigest() {
  if (!ALERT_EMAIL) { return; }
  var rows = sheetNamed(SUMMARY_SHEET, SUMMARY_HEADERS).getDataRange().getValues();

  var lines = [];
  var machines = 0;
  for (var i = 1; i < rows.length; i++) {
    lines.push([String(rows[i][0]), Number(rows[i][1]) || 0]);
    machines += Number(rows[i][1]) || 0;
  }
  lines.sort(function (a, b) { return b[1] - a[1]; });

  var body = ['Wordiv beta, current state:', '',
              '  codes in use : ' + lines.length,
              '  machines     : ' + machines, ''];
  if (!lines.length) {
    body.push('Nothing has reported yet.');
  } else {
    body.push('Machines per code, busiest first:');
    for (var j = 0; j < lines.length; j++) {
      body.push('  ' + lines[j][0] + '  ' + lines[j][1]);
    }
  }
  MailApp.sendEmail(ALERT_EMAIL, 'Wordiv beta: ' + lines.length +
                    ' codes, ' + machines + ' machines', body.join('\n'));
}


function sheetNamed(name, headers) {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}


function json(payload) {
  return ContentService
      .createTextOutput(JSON.stringify(payload))
      .setMimeType(ContentService.MimeType.JSON);
}
