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
 *   7. Run sendTestCode from the editor: it mails you the real thing with a
 *      dummy code, so you can check it without spending one from the pool.
 *      Then submit the form yourself once to prove the trigger fires too.
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
// The videos. Both are ALSO on the download page, and they belong in both:
// that page is unlinked from the site's navigation on purpose, so a tester who
// has already installed the app has no way back to it. This mail is the only
// thing they keep, so it has to carry the links itself.
//
// The BUTTON is the 13-minute overview, not the 38-minute guide. Somebody who
// has just been handed a code is about to install, and the video that gets
// them started is the short one; the full guide is offered underneath it, in
// text, for whoever wants to go deeper. That ordering matches the site.
var OVERVIEW_URL = 'https://youtu.be/u7CgQM7wUaE';   // 13:00, all capabilities
var GUIDE_URL = 'https://youtu.be/Z_Dnpc8J2WI';      // 38:15, chaptered
// The two SmartScreen screenshots, with the control to click ringed on each.
// They live beside the download page so the page and this mail cannot drift
// apart, and they ride WITH the message rather than as remote <img> tags --
// see smartScreenImages() for why that distinction is the whole point.
var SMARTSCREEN_SHOTS = [
  'https://www.wordiv.app/smartscreen-step1.png',
  'https://www.wordiv.app/smartscreen-step2.png'
];
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

/**
 * Fetch the two SmartScreen screenshots so they can be attached to the mail
 * and referenced as cid:, instead of being linked from the web.
 *
 * Outlook and most corporate clients block remote images by default, and the
 * one instruction in this mail that must never render as a broken box is the
 * one that gets somebody past a screen telling them the file is dangerous.
 * A cid: image is part of the message and always displays.
 *
 * ALL OR NOTHING on purpose: one screenshot arriving without the other would
 * leave step 2 illustrated and step 1 not, which reads as a fault in the mail.
 * An empty result sends the same message with no <img> tags at all -- both
 * steps are spelled out in words regardless, so a failed fetch costs a
 * nicety and never the instruction.
 */
function smartScreenImages() {
  var out = {};
  for (var i = 0; i < SMARTSCREEN_SHOTS.length; i++) {
    try {
      var res = UrlFetchApp.fetch(SMARTSCREEN_SHOTS[i], { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) {
        console.warn('SmartScreen shot ' + SMARTSCREEN_SHOTS[i] + ' returned ' +
                     res.getResponseCode() + '; sending without screenshots.');
        return {};
      }
      out['ss' + (i + 1)] = res.getBlob().setName('smartscreen-step' + (i + 1) + '.png');
    } catch (err) {
      console.warn('SmartScreen shot fetch failed: ' + err);
      return {};
    }
  }
  return out;
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
  var inline = smartScreenImages();
  var shots = Object.keys(inline).length === SMARTSCREEN_SHOTS.length;
  var helloText = name ? ('שלום ' + name + ',') : 'שלום,';
  var helloHtml = name ? ('שלום ' + escapeHtml(name) + ',') : 'שלום,';

  // ORDER MATTERS, and it is not the obvious one. The download button used to
  // sit directly under the code, and people did exactly what that invites:
  // copy the code, press download, leave. They never scrolled to the video or
  // to the SmartScreen walkthrough, so they met the blue "Windows protected
  // your PC" screen with no idea it was coming and no idea the guide existed.
  // The button is now LAST, after the two things worth ninety seconds, and a
  // line near the top says so -- a button that merely looks missing would send
  // somebody back to the form.

  // Plain-text fallback for clients that can't render HTML. Gmail itself
  // prefers htmlBody below, which is what actually fixes the alignment --
  // a plain-text mail client picks each PARAGRAPH's direction from its own
  // first character, and a paragraph starting with the code or the URL
  // (Latin/digits) renders left-aligned and drags the rest with it.
  var body =
    helloText + '\n\n' +
    'תודה שהצטרפת לבטא של ' + PRODUCT + '! הנה קוד הגישה האישי שלך:\n\n' +
    '    ' + code + '\n\n' +
    'לפני ההורדה — שתי דקות קריאה שיחסכו לך זמן. קישור ההורדה נמצא בתחתית ' +
    'המייל, אחרי שני הדברים האלה.\n\n' +
    'מומלץ לצפות בסקירת היכולות לפני שמתחילים — 13 דקות שעוברות על כל מה ' +
    'שהתוכנה יודעת לעשות, מחולקות לפרקים ביוטיוב. לתוכנה יש הרבה מאוד יכולות, ' +
    'וצריך לדעת איך להשתמש בהן כדי ליהנות באמת ממה שהיא נותנת.\n\n' +
    'סקירת היכולות (13 דקות): ' + OVERVIEW_URL + '\n\n' +
    'ואם בא לך להעמיק, יש גם מדריך מלא בן 38 דקות על התפעול של כל יכולת. הוא ' +
    'מחולק לפרקים ביוטיוב, כך שאפשר לעבור ישירות ליכולת שמעניינת אותך.\n\n' +
    'המדריך המלא (38 דקות): ' + GUIDE_URL + '\n\n' +
    'לפני ההתקנה — מסך כחול של Windows, וזה בסדר גמור:\n' +
    'בפעם הראשונה שתריצו את הקובץ, Windows יציג מסך כחול שאומר "Windows הגן ' +
    'על המחשב שלך". זה לא אומר שמשהו לא תקין בתוכנה — Windows מציג את המסך ' +
    'הזה לכל תוכנה חדשה עד שמספיק אנשים בעולם הורידו אותה, ואנחנו בתחילת ' +
    'הבטא. Wordiv חתומה דיגיטלית בתעודה רשמית על שם Shachar Perlman, ואחרי ' +
    'לחיצה על "מידע נוסף" השם מופיע שם בשורת "מפרסם".\n' +
    '    1. לוחצים על "מידע נוסף"\n' +
    '    2. לוחצים על "הפעל בכל מקרה", וההתקנה ממשיכה כרגיל\n\n' +
    'וזהו — אפשר להוריד:\n' +
    'להורדה: ' + DOWNLOAD_URL + '\n\n' +
    'בהפעלה הראשונה תתבקש/י להזין את הקוד. זה נדרש פעם אחת בלבד, וצריך חיבור ' +
    'לאינטרנט רק לרגע הזה. תקופת הניסיון שלך היא ' + TRIAL_DAYS + ' יום מרגע ' +
    'ההפעלה.\n\n' +
    'הקוד אישי ומיועד רק לך — נא לא לשתף אותו.\n\n' +
    'כדאי לשמור את המייל הזה: הוא מרכז את הקוד, קישור ההורדה והקישורים ' +
    'לסרטונים.\n\n' +
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
    // Says where the button went. Without this the mail reads as one that
    // forgot to include a download link, and the fix for that is a second
    // email, not a scroll.
    '<p style="margin-top:24px;background:#F4F7EC;border-right:3px solid #5C8A1E;' +
      'padding:12px 14px;"><b>לפני ההורדה — שתי דקות קריאה שיחסכו לך זמן.</b><br>' +
      'כפתור ההורדה נמצא בתחתית המייל, אחרי שני הדברים האלה.</p>' +
    // The video gets a SECONDARY button -- outlined, not filled, so it never
    // competes with the download button below. The raw URL is printed under
    // it because a tester coming back to this mail months later must be able
    // to copy it out, not just click it.
    '<p style="margin-top:26px;"><b>מומלץ לצפות בסקירת היכולות לפני שמתחילים.</b> ' +
    '13 דקות שעוברות על כל מה שהתוכנה יודעת לעשות, מחולקות לפרקים ביוטיוב. ' +
    'לתוכנה יש הרבה מאוד יכולות, ' +
    'וצריך לדעת איך להשתמש בהן כדי ליהנות באמת ממה שהיא נותנת.</p>' +
    '<p style="text-align:center;margin:20px 0 6px;">' +
      '<a href="' + OVERVIEW_URL + '" style="display:inline-block;' +
      'background-color:#ffffff;color:#5C8A1E;border:2px solid #5C8A1E;' +
      'text-decoration:none;font-weight:700;font-size:15px;padding:10px 28px;' +
      'border-radius:8px;font-family:Arial,Tahoma,sans-serif;">' +
      'צפייה בסקירת היכולות · 13 דקות</a>' +
    '</p>' +
    '<p style="text-align:center;font-size:12px;color:#777;">' +
      '<a dir="ltr" href="' + OVERVIEW_URL + '" style="direction:ltr;color:#5C8A1E;">' +
      OVERVIEW_URL + '</a></p>' +
    // The full guide stays a text link rather than a third button.
    '<p style="margin-top:18px;">ואם בא לך להעמיק, יש גם ' +
      '<a href="' + GUIDE_URL + '" style="color:#5C8A1E;">מדריך מלא בן 38 דקות</a> ' +
      'על התפעול של כל יכולת. הוא מחולק לפרקים ביוטיוב, כך שאפשר לעבור ישירות ' +
      'ליכולת שמעניינת אותך.<br>' +
      '<a dir="ltr" href="' + GUIDE_URL + '" style="direction:ltr;color:#5C8A1E;' +
      'font-size:12px;">' + GUIDE_URL + '</a></p>' +
    // The walkthrough stays immediately ABOVE the download button, so the
    // screen it describes is the last thing read before the file is fetched.
    // Tone is deliberate: the reader is about to be told by their own
    // operating system that this file is dangerous.
    '<p style="margin-top:28px;"><b>לפני ההתקנה — מסך כחול של Windows, וזה בסדר גמור.</b></p>' +
    '<p>בפעם הראשונה שתריצו את הקובץ, Windows יציג מסך כחול שאומר ' +
    '<b>"Windows הגן על המחשב שלך"</b>. זה נשמע מפחיד, וזה לא אומר שמשהו לא ' +
    'תקין בתוכנה: Windows סופר כמה אנשים בעולם כבר הורידו קובץ מסוים, ועד ' +
    'שהמספר הזה גדל מספיק הוא מציג את המסך הזה לכל תוכנה חדשה — ואנחנו ' +
    'בתחילת הבטא, אז אנחנו בדיוק שם.</p>' +
    '<p>' + PRODUCT + ' <b>חתומה דיגיטלית</b> בתעודה רשמית על שם ' +
    'Shachar Perlman, ואפשר לראות את זה במסך עצמו: ברגע שלוחצים על "מידע ' +
    'נוסף" נפתחת שורת <b>מפרסם</b> עם השם. ככה יודעים שזה באמת הקובץ שלנו.</p>' +
    '<p style="margin-top:18px;">אז כשהמסך הזה מופיע, שני צעדים:</p>' +
    '<p style="margin:14px 0 4px;"><b>1.</b> לוחצים על ' +
    '<b style="color:#5C8A1E;">מידע נוסף</b>.</p>' +
    (shots ? '<p style="margin:0 0 18px;"><img src="cid:ss1" width="380" ' +
      'alt="מסך SmartScreen עם הקישור מידע נוסף מסומן" ' +
      'style="display:block;max-width:100%;height:auto;border:1px solid #ddd;' +
      'border-radius:8px;"></p>' : '') +
    '<p style="margin:14px 0 4px;"><b>2.</b> לוחצים על ' +
    '<b style="color:#5C8A1E;">הפעל בכל מקרה</b>, וההתקנה ממשיכה כרגיל.</p>' +
    (shots ? '<p style="margin:0 0 18px;"><img src="cid:ss2" width="380" ' +
      'alt="אותו מסך אחרי לחיצה על מידע נוסף, עם הכפתור הפעל בכל מקרה מסומן" ' +
      'style="display:block;max-width:100%;height:auto;border:1px solid #ddd;' +
      'border-radius:8px;"></p>' : '') +
    // THE action of this mail, and the reason everything above it is short.
    // Inline styles only, so it survives Outlook/Gmail stripping <style>.
    '<p style="margin-top:32px;text-align:center;"><b>וזהו — אפשר להוריד.</b></p>' +
    '<p style="text-align:center;margin:14px 0;">' +
      '<a href="' + DOWNLOAD_URL + '" style="display:inline-block;' +
      'background-color:#5C8A1E;color:#ffffff;text-decoration:none;' +
      'font-weight:700;font-size:16px;padding:14px 38px;border-radius:8px;' +
      'font-family:Arial,Tahoma,sans-serif;">הורדת ' + PRODUCT + '</a>' +
    '</p>' +
    '<p style="text-align:center;font-size:12px;color:#777;">' +
      'אם הכפתור לא עובד, אפשר להעתיק את הקישור:<br>' +
      '<a dir="ltr" href="' + DOWNLOAD_URL + '" style="direction:ltr;color:#5C8A1E;">' +
      DOWNLOAD_URL + '</a></p>' +
    '<p style="margin-top:26px;">בהפעלה הראשונה תתבקש/י להזין את הקוד. זה נדרש ' +
    'פעם אחת בלבד, וצריך חיבור לאינטרנט רק לרגע הזה. תקופת הניסיון שלך היא ' +
    TRIAL_DAYS + ' יום מרגע ההפעלה.</p>' +
    '<p>הקוד אישי ומיועד רק לך — נא לא לשתף אותו.</p>' +
    '<p>כדאי לשמור את המייל הזה: הוא מרכז את הקוד, קישור ההורדה והקישורים ' +
    'לסרטונים.</p>' +
    '<p>תודה שאת/ה עוזר/ת לנו לבדוק את התוכנה, ונשמח לשמוע ממך מה עובד ומה לא.</p>' +
    '</div>';

  MailApp.sendEmail({
    to: email,
    subject: 'קוד הגישה שלך לבטא של ' + PRODUCT,
    body: body,
    htmlBody: htmlBody,
    inlineImages: inline,
    name: PRODUCT
  });
}

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

/**
 * Run this by hand from the editor to see the real mail, without spending a
 * code. It goes to whoever authorised the script -- you -- and the codes sheet
 * is never opened, so nothing is claimed or marked as assigned.
 *
 * It calls sendCode itself rather than building its own preview. That is the
 * point: a preview assembled separately drifts from the mail it is previewing
 * the first time one of them is edited, and then quietly reassures you about
 * something you are not sending.
 */
function sendTestCode() {
  var to = Session.getEffectiveUser().getEmail();
  // Five groups of four, the same shape a real code has, so the chip in the
  // mail is the width it will really be -- a preview that lies about the
  // layout is worse than no preview. Unmistakably fake all the same.
  sendCode(to, 'בדיקה', 'TEST-TEST-TEST-TEST-TEST');
  console.log('Test mail sent to ' + to + '. The codes sheet was not touched.');
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
