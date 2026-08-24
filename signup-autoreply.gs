/**
 * Wordiv beta — hand out a pre-minted code automatically on signup.
 *
 * This is Google Apps Script. It is NOT part of the app and nothing fetches
 * it; it lives here so the whole distribution story sits in one repository.
 *
 * WHAT IT DOES
 *   A signup form asks for a name and an email. On every submission this
 *   script takes the next unused code from the "codes" sheet, marks it as
 *   assigned to that person, and emails it to them. No server, no waiting on
 *   a human, and you keep a row-by-row record of which code went to whom --
 *   which is the entire point of per-person codes: if one leaks, you know
 *   whose it was and you delete that one hash.
 *
 * SETUP, ONCE
 *   1. Mint a pool and publish the hashes:
 *          python make_code_batch.py 100
 *          git add beta-codes.json && git commit -m "Publish 100 beta codes"
 *          git push
 *   2. Make a Google Form: Name (short answer), Email (short answer, set
 *      Response validation -> Text -> Email address). Turn OFF "Collect email
 *      addresses" or adjust EMAIL_QUESTION below to match.
 *   3. In the Form: Responses -> Link to Sheets -> create a spreadsheet.
 *   4. In that spreadsheet: File -> Import -> Upload codes-<date>.csv ->
 *      "Insert new sheet". Rename the new sheet to exactly  codes
 *      It must have the header row: code | assigned_to | assigned_on
 *   5. Extensions -> Apps Script. Delete whatever is there, paste this file,
 *      Save.
 *   6. Left sidebar -> Triggers (the clock icon) -> Add trigger:
 *          function: onFormSubmit
 *          event source: From spreadsheet
 *          event type: On form submit
 *      Authorise it when Google asks (it needs to send mail as you).
 *   7. Submit the form yourself once and check the email arrives.
 *
 * WHEN THE POOL RUNS LOW
 *   Run make_code_batch.py again, push, and paste the new rows at the bottom
 *   of the "codes" sheet. LOW_WATER_MARK below emails you a warning first.
 *
 * NEVER paste the contents of the codes sheet anywhere public. Those are
 * working codes; only their hashes belong in beta-codes.json.
 */

// ---- settings ------------------------------------------------------------

var CODES_SHEET = 'codes';
var EMAIL_QUESTION = 'Email';     // the form question holding the address
var NAME_QUESTION = 'Name';       // optional; used only to say hello
var PRODUCT = 'Wordiv';
var DOWNLOAD_URL = 'https://github.com/abashelnoa/wordiv-releases/releases/latest';
var TRIAL_DAYS = 60;
var LOW_WATER_MARK = 10;          // warn you when fewer than this remain

// ---- the trigger ---------------------------------------------------------

function onFormSubmit(e) {
  var answers = readAnswers(e);
  var email = answers[EMAIL_QUESTION];
  if (!email) {
    console.error('No email in the submission; nothing sent.');
    return;
  }

  // Two people can submit in the same second. Without this lock they can be
  // handed the SAME code, and one of them is then untraceable.
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var code, remaining;
  try {
    var claimed = claimNextCode(email);
    code = claimed.code;
    remaining = claimed.remaining;
  } finally {
    lock.releaseLock();
  }

  if (!code) {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
      PRODUCT + ' beta: OUT OF CODES',
      'Someone signed up (' + email + ') and there were no codes left.\n' +
      'Run make_code_batch.py, push, and paste the new rows into the "' +
      CODES_SHEET + '" sheet, then send them a code by hand.');
    return;
  }

  sendCode(email, answers[NAME_QUESTION] || '', code);

  if (remaining < LOW_WATER_MARK) {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
      PRODUCT + ' beta: only ' + remaining + ' codes left',
      'Time to mint more:\n\n  python make_code_batch.py 100\n' +
      '  git add beta-codes.json && git commit -m "Publish 100 beta codes"\n' +
      '  git push\n\nThen paste the new rows into the "' + CODES_SHEET + '" sheet.');
  }
}

// ---- helpers -------------------------------------------------------------

function readAnswers(e) {
  var out = {};
  if (e && e.namedValues) {
    for (var key in e.namedValues) {
      var value = e.namedValues[key];
      out[key.trim()] = (value && value.length) ? String(value[0]).trim() : '';
    }
  }
  return out;
}

/** Take the first row with no assignee. Returns {code, remaining}. */
function claimNextCode(email) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CODES_SHEET);
  if (!sheet) {
    throw new Error('No sheet named "' + CODES_SHEET + '".');
  }
  var values = sheet.getDataRange().getValues();   // row 0 is the header
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(),
                                   'yyyy-MM-dd');
  var chosen = '';
  var remaining = 0;

  for (var i = 1; i < values.length; i++) {
    var code = String(values[i][0] || '').trim();
    var assignedTo = String(values[i][1] || '').trim();
    if (!code) { continue; }
    if (assignedTo) { continue; }
    if (!chosen) {
      chosen = code;
      sheet.getRange(i + 1, 2).setValue(email);
      sheet.getRange(i + 1, 3).setValue(today);
      SpreadsheetApp.flush();     // commit before the lock is released
    } else {
      remaining++;
    }
  }
  return { code: chosen, remaining: remaining };
}

function sendCode(email, name, code) {
  var hello = name ? ('Hi ' + name + ',') : 'Hi,';
  var body =
    hello + '\n\n' +
    'Thanks for joining the ' + PRODUCT + ' beta. Here is your personal ' +
    'access code:\n\n' +
    '    ' + code + '\n\n' +
    'Download and install ' + PRODUCT + ':\n    ' + DOWNLOAD_URL + '\n\n' +
    'The first time you run it, paste the code in when asked. You only need ' +
    'to do that once, and it needs an internet connection just for that ' +
    'first check. Your trial runs for ' + TRIAL_DAYS + ' days from then.\n\n' +
    'The code is yours alone — please do not share it.\n\n' +
    'Thanks for helping test it, and do tell us what breaks.\n';

  MailApp.sendEmail({
    to: email,
    subject: 'Your ' + PRODUCT + ' beta access code',
    body: body,
    name: PRODUCT
  });
}

/** Run this by hand from the editor to check the sheet is wired up. */
function checkSetup() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CODES_SHEET);
  if (!sheet) {
    console.error('FAIL: no sheet named "' + CODES_SHEET + '"');
    return;
  }
  var values = sheet.getDataRange().getValues();
  var header = values[0].join(' | ');
  var free = 0, used = 0;
  for (var i = 1; i < values.length; i++) {
    if (!String(values[i][0] || '').trim()) { continue; }
    if (String(values[i][1] || '').trim()) { used++; } else { free++; }
  }
  console.log('header : ' + header);
  console.log('codes  : ' + free + ' free, ' + used + ' already assigned');
  console.log(free ? 'OK — ready to hand out codes.' : 'NO CODES LEFT.');
}
