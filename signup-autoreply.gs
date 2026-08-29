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
// The form question titles. Both are matched case-insensitively, and several
// spellings are accepted, because Google names the automatic column
// "Email Address" while a question you add yourself is usually just "Email" --
// and an AI-generated form may pick something else again. If the address is
// still not found, the script falls back to the verified respondent email that
// "Collect email addresses" provides, so a mismatch here cannot silently drop
// a signup.
var EMAIL_QUESTION = 'Email';
var EMAIL_ALIASES = ['email', 'email address', 'e-mail', 'your email',
                     'email addresses', 'כתובת אימייל', 'אימייל'];
var NAME_QUESTION = 'Name';       // optional; used only to say hello
var NAME_ALIASES = ['name', 'full name', 'your name', 'first name', 'שם'];
var PRODUCT = 'Wordiv';
// Where the confirmation email sends people to download the installer. Points
// straight at the GitHub release for now; once a real site exists, change
// this ONE line to the site's download page and nothing else needs to move --
// the file itself can still live on GitHub, or move anywhere the site links to.
var DOWNLOAD_URL = 'https://www.wordiv.app/#/download';
var TRIAL_DAYS = 60;
var LOW_WATER_MARK = 10;          // warn you when fewer than this remain

// ---- the trigger ---------------------------------------------------------

function onFormSubmit(e) {
  var answers = readAnswers(e);
  var email = pick(answers, EMAIL_QUESTION, EMAIL_ALIASES) || respondentEmail(e);
  if (!email) {
    console.error('No email in the submission; nothing sent. Columns seen: ' +
                  Object.keys(answers).join(', '));
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
      PRODUCT + ' beta: a signup had no email address',
      'A form response arrived with no usable email address, so no code was ' +
      'sent. Columns seen:\n\n  ' + Object.keys(answers).join('\n  ') +
      '\n\nAdd the right title to EMAIL_ALIASES in the script, or turn on ' +
      '"Collect email addresses" in the form.');
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
    // Two emails, two audiences: the signer-upper must not be left in
    // silence after the generic "your response was recorded" Forms page --
    // without this they never learn why no code arrived. The admin alert
    // stays as the actionable "go mint more" nudge.
    sendSoldOut(email, pick(answers, NAME_QUESTION, NAME_ALIASES));
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
      PRODUCT + ' בטא: נגמרו הקודים',
      'מישהו נרשם (' + email + ') ולא נשארו קודים - נשלחה לו הודעת "אזלו הקודים".\n' +
      'הרץ python make_code_batch.py, דחוף, והדבק את השורות החדשות ללשונית "' +
      CODES_SHEET + '".');
    return;
  }

  sendCode(email, pick(answers, NAME_QUESTION, NAME_ALIASES), code);

  if (remaining < LOW_WATER_MARK) {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
      PRODUCT + ' בטא: נשארו רק ' + remaining + ' קודים',
      'זמן לייצר עוד:\n\n  python make_code_batch.py 100\n' +
      '  git add beta-codes.json && git commit -m "Publish 100 beta codes"\n' +
      '  git push\n\nואז להדביק את השורות החדשות ללשונית "' + CODES_SHEET + '".');
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

/** First non-empty answer whose title matches `preferred` or any alias. */
function pick(answers, preferred, aliases) {
  var wanted = [String(preferred || '').toLowerCase()];
  for (var i = 0; i < aliases.length; i++) { wanted.push(aliases[i].toLowerCase()); }
  for (var w = 0; w < wanted.length; w++) {
    for (var key in answers) {
      if (key.toLowerCase() === wanted[w] && answers[key]) { return answers[key]; }
    }
  }
  return '';
}

/** The verified address Google attaches when "Collect email addresses" is on. */
function respondentEmail(e) {
  try {
    if (e && e.response && e.response.getRespondentEmail) {
      return String(e.response.getRespondentEmail() || '').trim();
    }
  } catch (err) {
    console.warn('could not read the respondent email: ' + err);
  }
  return '';
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

/** Minimal HTML escaping for text interpolated into htmlBody below. */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendCode(email, name, code) {
  var helloText = name ? ('שלום ' + name + ',') : 'שלום,';
  var helloHtml = name ? ('שלום ' + escapeHtml(name) + ',') : 'שלום,';

  // Plain-text fallback for clients that can't render HTML. Gmail itself
  // prefers htmlBody below, which is what actually fixes the alignment --
  // a plain-text mail client picks each PARAGRAPH's direction from its own
  // first character, and a paragraph starting with the code or the URL
  // (Latin/digits) renders left-aligned and drags the rest with it.
  var body =
    helloText + '\n\n' +
    'תודה שהצטרפת לבטא של ' + PRODUCT + '! הנה קוד הגישה האישי שלך:\n\n' +
    '    ' + code + '\n\n' +
    'להורדה: ' + DOWNLOAD_URL + '\n\n' +
    'בהפעלה הראשונה תתבקש/י להזין את הקוד. זה נדרש פעם אחת בלבד, וצריך חיבור ' +
    'לאינטרנט רק לרגע הזה. תקופת הניסיון שלך היא ' + TRIAL_DAYS + ' יום מרגע ' +
    'ההפעלה.\n\n' +
    'הקוד אישי ומיועד רק לך — נא לא לשתף אותו.\n\n' +
    'תודה שאת/ה עוזר/ת לנו לבדוק את התוכנה, ונשמח לשמוע ממך מה עובד ומה לא.\n';

  // The whole message is forced dir="rtl" / text-align:right, and only the
  // code and the URL are wrapped in their own dir="ltr" span -- an island
  // that stays left-to-right internally WITHOUT flipping the paragraph
  // around it, the same bidi-isolation idea the app itself uses for mixed
  // Hebrew/English text.
  var htmlBody =
    '<div dir="rtl" style="text-align:right;font-family:Arial,Tahoma,sans-serif;' +
    'font-size:14px;line-height:1.7;color:#222;">' +
    '<p>' + helloHtml + '</p>' +
    '<p>תודה שהצטרפת לבטא של ' + PRODUCT + '! הנה קוד הגישה האישי שלך:</p>' +
    '<p style="text-align:center;">' +
      '<span dir="ltr" style="display:inline-block;font-family:Consolas,monospace;' +
      'font-size:18px;font-weight:bold;letter-spacing:1px;background:#f2f2f2;' +
      'padding:8px 16px;border-radius:6px;">' + escapeHtml(code) + '</span>' +
    '</p>' +
    '<p style="text-align:center;font-size:12px;color:#777;margin-top:-6px;">' +
      '(לחיצה כפולה על הקוד מסמנת אותו להעתקה)</p>' +
    // A real button -- inline styles only, so it survives Outlook/Gmail
    // stripping <style> blocks. No JavaScript: an email client cannot run
    // a "copy" button, so the code above is a big, easy-to-select chip
    // instead -- the same pattern Stripe/GitHub use for the same reason.
    '<p style="text-align:center;margin:24px 0;">' +
      '<a href="' + DOWNLOAD_URL + '" style="display:inline-block;' +
      'background-color:#5C8A1E;color:#ffffff;text-decoration:none;' +
      'font-weight:700;font-size:15px;padding:12px 32px;border-radius:8px;' +
      'font-family:Arial,Tahoma,sans-serif;">הורדת ' + PRODUCT + '</a>' +
    '</p>' +
    '<p style="text-align:center;font-size:12px;color:#777;">' +
      'אם הכפתור לא עובד, אפשר להעתיק את הקישור:<br>' +
      '<a dir="ltr" href="' + DOWNLOAD_URL + '" style="direction:ltr;color:#5C8A1E;">' +
      DOWNLOAD_URL + '</a></p>' +
    '<p>בהפעלה הראשונה תתבקש/י להזין את הקוד. זה נדרש פעם אחת בלבד, וצריך חיבור ' +
    'לאינטרנט רק לרגע הזה. תקופת הניסיון שלך היא ' + TRIAL_DAYS + ' יום מרגע ' +
    'ההפעלה.</p>' +
    '<p>הקוד אישי ומיועד רק לך — נא לא לשתף אותו.</p>' +
    '<p>תודה שאת/ה עוזר/ת לנו לבדוק את התוכנה, ונשמח לשמוע ממך מה עובד ומה לא.</p>' +
    '</div>';

  MailApp.sendEmail({
    to: email,
    subject: 'קוד הגישה שלך לבטא של ' + PRODUCT,
    body: body,
    htmlBody: htmlBody,
    name: PRODUCT
  });
}

/** Run this by hand from the editor to check the sheet is wired up. */
/** Sent to the SIGNER when the pool is empty -- see the comment above the call. */
function sendSoldOut(email, name) {
  var helloText = name ? ('שלום ' + name + ',') : 'שלום,';
  var helloHtml = name ? ('שלום ' + escapeHtml(name) + ',') : 'שלום,';

  var body =
    helloText + '\n\n' +
    'תודה על ההתעניינות שלך ב-' + PRODUCT + '! כרגע כל קודי הגישה לבטא ' +
    'נוצלו. אנחנו מוסיפים עוד קודים בהמשך — כדאי לנסות למלא את הטופס ' +
    'שוב בעוד כמה ימים.\n\n' +
    'תודה על הסבלנות!\n';

  var htmlBody =
    '<div dir="rtl" style="text-align:right;font-family:Arial,Tahoma,sans-serif;' +
    'font-size:14px;line-height:1.7;color:#222;">' +
    '<p>' + helloHtml + '</p>' +
    '<p>תודה על ההתעניינות שלך ב-' + PRODUCT + '! כרגע כל קודי הגישה לבטא ' +
    'נוצלו. אנחנו מוסיפים עוד קודים בהמשך — כדאי לנסות למלא את הטופס ' +
    'שוב בעוד כמה ימים.</p>' +
    '<p>תודה על הסבלנות!</p>' +
    '</div>';

  MailApp.sendEmail({
    to: email,
    subject: PRODUCT + ' — כרגע אין קודי גישה פנויים',
    body: body,
    htmlBody: htmlBody,
    name: PRODUCT
  });
}

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
