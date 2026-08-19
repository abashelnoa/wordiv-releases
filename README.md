# Wordiv — Releases

**This is a distribution repository. It contains no source code.**

Wordiv is a Windows voice dictation and translation app. Its source lives in a
separate private repository; this one exists only to publish the installer and
the two small JSON files the app reads at runtime.

## What is here

| File | What it is for |
|---|---|
| [`version.json`](version.json) | The latest released version, the download link for its installer, and its release notes. The app fetches this to find out whether an update is available. |
| [`beta-codes.json`](beta-codes.json) | The SHA-256 hashes of the beta access codes that are currently valid. **The codes themselves are not here** — see below. |

Installers (`Wordiv-Setup.exe`) are attached to
[Releases](../../releases), not committed to the repository.

Both JSON files are read over plain HTTPS with no authentication:

```
https://raw.githubusercontent.com/abashelnoa/wordiv-releases/main/version.json
https://raw.githubusercontent.com/abashelnoa/wordiv-releases/main/beta-codes.json
```

## Beta codes are stored as hashes, never as codes

This repository is public, so anything written into `beta-codes.json` is
readable by anyone who finds it. It therefore holds only the SHA-256 hash of
each valid code: the app can check a code the user typed without the published
list ever containing a working one.

A code is hashed like this, and the app must reproduce it exactly:

```python
normalized = "".join(code.split()).upper()          # drop all whitespace, upper-case
digest     = sha256(normalized.encode("utf-8")).hexdigest()   # lowercase hex
```

Dashes are significant; whitespace and letter case are not.

[`add_beta_code.py`](add_beta_code.py) is the tool that maintains the list. It
runs locally, prints the plaintext code to the terminal so it can be sent to a
tester, and writes only the hash to the file:

```bash
python add_beta_code.py --generate          # invent a strong code and add it
python add_beta_code.py WRDV-ABCD-1234      # add a code you chose yourself
python add_beta_code.py --check WRDV-...    # is this one already listed?
```

Prefer `--generate`. A hash only protects a code that cannot be guessed, and a
short or memorable code can be brute-forced offline from its hash in seconds;
the generated format carries about 78 bits of entropy.

---

# Wordiv — קבצי הפצה

**זהו ריפו הפצה בלבד. אין בו קוד מקור.**

Wordiv היא תוכנת הכתבה ותרגום קולי ל‑Windows. קוד המקור שלה נמצא בריפו פרטי
נפרד; הריפו הזה קיים רק כדי לפרסם את קובץ ההתקנה ואת שני קבצי ה‑JSON הקטנים
שהתוכנה קוראת בזמן ריצה.

* **`version.json`** — מספר הגרסה האחרונה, קישור ההורדה למתקין שלה ותיאור
  השינויים. התוכנה קוראת את הקובץ הזה כדי לדעת אם יצאה גרסה חדשה.
* **`beta-codes.json`** — הטביעות (SHA‑256) של קודי הבטא התקפים. **הקודים
  עצמם אינם נמצאים כאן**, מפני שהריפו ציבורי וכל אחד יכול לקרוא אותו. התוכנה
  מחשבת את הטביעה של הקוד שהמשתמש הקליד ומשווה לרשימה, כך שהרשימה המפורסמת
  לעולם אינה מכילה קוד עובד.

קבצי ההתקנה (`Wordiv-Setup.exe`) מצורפים ל‑[Releases](../../releases) ואינם
נשמרים בריפו עצמו.

הוספת קוד בטא נעשית עם [`add_beta_code.py`](add_beta_code.py), שרץ במחשב
המקומי בלבד: הוא מדפיס את הקוד למסך כדי שאפשר יהיה לשלוח אותו לנסיין, וכותב
לקובץ רק את הטביעה שלו. עדיף להשתמש ב‑`--generate` — טביעה מגינה רק על קוד
שאי אפשר לנחש, וקוד קצר או קריא ניתן לפיצוח מהטביעה שלו במהירות.
