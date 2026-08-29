import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkOtp, isOtpMessage } from "../src/privacy/otp-filter.js";

// All strings below are fabricated. None come from a real inbox.

const MUST_FILTER: Array<[string, string]> = [
  // --- classic "your code is" wording, 4–8 digits ---
  ["verification code 6", "Your verification code is 483920."],
  ["verification code 4", "Your verification code is 4839"],
  ["verification code 8", "Your verification code is 48392011"],
  ["security code", "Your security code: 921 004"],
  ["auth code", "Authentication code 55129 expires in 10 minutes."],
  ["login code", "Here is your login code: 220981"],
  ["sign-in code", "Your sign-in code is 771 220"],
  ["access code", "Access code 402913 for your appointment portal"],
  ["confirmation code", "Confirmation code: 88231"],
  ["one-time password", "Your one-time password is 118822"],
  ["one time password", "One time password 5501 (valid for 5 min)"],
  ["one-time passcode", "one-time passcode: 77 11 22"],
  ["OTP", "OTP 445566"],
  ["otp lower", "your otp is 991 288 - valid 2 minutes"],
  ["2FA", "2FA code 138 400"],
  ["MFA", "MFA verification: 200 199"],
  ["two-factor", "Two-factor authentication code 500 601"],
  ["passcode", "Your passcode is 3391"],
  ["PIN is", "Your temporary PIN is 4410."],
  ["PIN enter", "Enter PIN 9921 to confirm the transfer"],
  ["do not share", "Do not share this code with anyone: 712 003"],
  ["dont share", "Don't share this code with anyone. 712003"],
  ["never share", "Never share your code. Code 44012."],
  ["temporary password", "Your temporary password is Qx7!ppL2"],
  ["password reset", "Reset your password using code 583 001"],
  ["activation code", "Activation code: 71AB9C"],
  ["recovery code", "Recovery code 1234-5678"],
  ["use code", "Use code 388120 to continue"],
  ["enter this code", "Enter this code to verify your number: 502 110"],
  ["code to log in", "Here is the code to log in: 7734"],
  ["code to verify", "code to verify your identity is 2203"],
  ["login attempt", "New login attempt from Chrome on Windows. Was this you?"],

  // --- alphanumeric codes ---
  ["alnum 6", "Your Slack confirmation code is ABX-92K"],
  ["alnum mixed", "Verification code: 7XK92Q"],
  ["alnum with digits", "Use A1B2C3 as your code."],
  ["alnum only-code msg", "R4ND0MC0DE"],

  // --- vendor templates ---
  ["google", "G-728172 is your Google verification code."],
  ["google 2", "Your Google verification code is 291 004"],
  ["apple id", "Your Apple ID Code is: 128 733. Don't share it with anyone."],
  ["apple account", "Your Apple Account code is 993 118."],
  ["microsoft", "Use 559102 as Microsoft account security code"],
  ["microsoft 2", "Microsoft account security code: 883 190"],
  ["whatsapp", "Your WhatsApp code: 448-119\nYou can also tap on this link to verify your phone: v.whatsapp.com/448119\nDon't share this code with others"],
  ["telegram", "Telegram code: 33189"],
  ["signal", "SIGNAL: Your code is: 512-933"],
  ["uber", "Your Uber code is 4412. Never share this code."],
  ["lyft", "Your Lyft code is 902 118"],
  ["amazon", "220188 is your Amazon OTP. Do not share it with anyone."],
  ["venmo", "Venmo here! Your verification code is 993018. Never share this code with anyone."],
  ["paypal", "PayPal: Your security code is 992 004. It expires in 10 minutes."],
  ["chase", "Chase: Your one-time code is 4471. It expires in 10 minutes."],
  ["wells fargo", "Wells Fargo: 738201 is your verification code."],
  ["bofa", "Bank of America: Use authorization code 40011 to complete your request"],
  ["capital one", "Capital One: Your temporary code is 5580"],
  ["amex", "Your American Express security code: 22119"],
  ["coinbase", "Coinbase: 118822 is your verification code."],
  ["okta", "Okta: Your verification code is 993 021"],
  ["duo", "Duo Security: your passcode is 4455 019"],
  ["discord", "Your Discord verification code is: 004 118"],
  ["instagram", "882 001 is your Instagram code. Don't share it."],
  ["facebook", "FB-99201 is your Facebook code"],
  ["tiktok", "[TikTok] 448120 is your verification code, valid for 5 minutes."],
  ["doordash", "DoorDash: Your verification code is 5591. Do not share this with anyone."],
  ["airbnb", "Your Airbnb verification code is 449012."],
  ["twilio", "Your Twilio Verify code is 118 223"],
  ["usps", "USPS: your one-time passcode is 771920"],
  ["android retriever", "<#> Your ExampleApp code is 118822\nFA+9qCX9VSu"],
  ["trailing hash", "Your code is 401 992. @example.com #401992"],
  ["generic is your", "482913 is your Uber code"],
  ["code colon", "Code: 118822"],
  ["expires in", "118822 — expires in 10 minutes"],
  ["valid for", "Code valid for 3 minutes: 552 001"],

  // --- links carrying tokens ---
  ["link code param", "Finish signing in: https://example.com/login?code=A8f9sD2k"],
  ["link token", "Reset here https://example.com/reset?token=eyJhbGciOiJIUzI1NiJ9.abc"],
  ["link verify path", "Confirm your email: https://app.example.com/verify/9f8e7d6c"],
  ["magic link", "Here's your magic link to sign in"],
  ["sign in link", "Tap this sign-in link: https://example.com/a?x=1"],
  ["otp path", "https://example.com/otp/118822"],

  // --- bare codes ---
  ["bare 6", "482913"],
  ["bare 4", "4471"],
  ["bare 8", "48291377"],
  ["bare dashed", "448-119"],
  ["bare spaced", "448 119"],
  ["bare with period", "482913."],

  // --- non-English ---
  ["spanish", "Tu código de verificación es 448 120"],
  ["french", "Votre code de vérification est 118 822"],
  ["german", "Ihr Bestätigungscode lautet 771 920"],
  ["italian", "Il tuo codice di verifica è 552001"],
  ["portuguese", "Seu código de verificação: 118822"],
  ["russian", "Ваш код подтверждения: 448120"],
  ["russian 2", "Никому не сообщайте код 4481"],
  ["japanese", "認証コード: 448120"],
  ["chinese", "您的验证码是 448120"],
  ["korean", "인증번호 [448120]"],

  // --- quoted in reactions / forwards ---
  ["tapback quoting otp", "Liked “Your verification code is 483920”"],
  ["forwarded", "fwd: Your login code is 220981"],
  ["subject only", ""],
];

const MUST_ALLOW: Array<[string, string]> = [
  ["plain chat", "hey, are we still on for dinner tomorrow?"],
  ["time", "meet at 10:30, I'll be there by 11"],
  ["time 2", "flight lands at 4:45pm"],
  ["money", "bring $1,200 for the deposit"],
  ["money 2", "it was like 2500 total"],
  ["phone number", "call me at 555-0100 when you land"],
  ["phone number 2", "my new number is (415) 555-0199"],
  ["year", "we went in 2019 right?"],
  ["year 2", "born in 1987"],
  ["address", "1234 Main Street, apt 5"],
  ["zip", "zip is 94107"],
  ["order number", "your order #4471 shipped"],
  ["flight number", "on UA1234, gate B12"],
  ["sports", "final score 21-14"],
  ["percent", "got 95% on the test"],
  ["long number no context", "the vin ends in 118822 and 4471 miles on it"],
  ["date", "on 12/25 at 3"],
  ["emoji", "🎉🎉🎉"],
  ["url plain", "https://example.com/article/123456-some-title"],
  ["url query", "https://example.com/search?q=shoes&page=2"],
  ["password talk no code", "I forgot my password again lol"],
  ["security no code", "the security guard was nice"],
  ["pin bowling", "we knocked down every pin"],
  ["pin it", "can you pin the message about the party"],
  ["code word", "the code was a mess, refactoring tomorrow"],
  ["verify no number", "can you verify he's coming?"],
  ["confirm no number", "just to confirm, 7pm?"],
  ["account no number", "my account got locked out, so annoying"],
  ["dimensions", "the table is 48x24 inches"],
  ["temperature", "it's 102 degrees out"],
  ["list", "1. milk 2. eggs 3. bread"],
  ["km", "ran 10k this morning, 5000 steps before noon"],
  ["hashtag", "#tbt 2015"],
  ["group chat", "in!"],
  ["empty", ""],
  ["whitespace", "   "],
  ["long text", "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua."],
  ["reaction", "Loved “group lunch friday?”"],
  ["4 digit year with verify but no code words", "can you confirm 2019 was the trip year"],
];

describe("otp-filter: must filter", () => {
  for (const [label, text] of MUST_FILTER) {
    if (text === "") continue;
    it(label, () => {
      const v = checkOtp({ text });
      assert.equal(v.filtered, true, `expected filtered: ${JSON.stringify(text)} reasons=${v.reasons.join(",")}`);
      assert.ok(v.reasons.length > 0);
    });
  }
});

describe("otp-filter: must allow", () => {
  for (const [label, text] of MUST_ALLOW) {
    it(label, () => {
      const v = checkOtp({ text });
      assert.equal(v.filtered, false, `expected allowed: ${JSON.stringify(text)} reasons=${v.reasons.join(",")}`);
    });
  }
});

describe("otp-filter: sender rules", () => {
  it("numeric short code sender is filtered regardless of text", () => {
    assert.equal(checkOtp({ text: "hello", senderHandle: "22395" }).filtered, true);
    assert.deepEqual(checkOtp({ text: "hello", senderHandle: "22395" }).reasons, ["sender_shortcode"]);
  });
  it("alphanumeric sender id is filtered", () => {
    assert.equal(checkOtp({ text: "Thanks for shopping", senderHandle: "AMAZON" }).filtered, true);
  });
  it("short code rule can be disabled", () => {
    assert.equal(checkOtp({ text: "hello", senderHandle: "22395" }, { filterShortcodeSenders: false }).filtered, false);
  });
  it("normal phone sender is not filtered", () => {
    assert.equal(checkOtp({ text: "hello", senderHandle: "+15550000001" }).filtered, false);
  });
  it("email sender is not filtered", () => {
    assert.equal(checkOtp({ text: "hello", senderHandle: "alice@example.com" }).filtered, false);
  });
  it("business urn sender is not filtered", () => {
    assert.equal(checkOtp({ text: "hello", senderHandle: "urn:biz:abc-123" }).filtered, false);
  });
  it("blocked handles match with formatting differences", () => {
    const opts = { blockedHandles: ["+1 (555) 000-0009", "Bank@Example.com"] };
    assert.equal(checkOtp({ text: "hi", senderHandle: "+15550000009" }, opts).filtered, true);
    assert.equal(checkOtp({ text: "hi", senderHandle: "bank@example.com" }, opts).filtered, true);
    assert.equal(checkOtp({ text: "hi", senderHandle: "+15550000001" }, opts).filtered, false);
  });
  it("blocked handle applies to my outgoing messages in that conversation", () => {
    const opts = { blockedHandles: ["+15550000009"] };
    assert.equal(checkOtp({ text: "ok", isFromMe: true, counterpartHandles: ["+15550000009"] }, opts).filtered, true);
  });
  it("my own messages are still content-filtered", () => {
    assert.equal(checkOtp({ text: "my code is 448120", isFromMe: true, senderHandle: undefined }).filtered, true);
  });
  it("a shortcode as the sender of my own outgoing row is ignored (isFromMe)", () => {
    assert.equal(checkOtp({ text: "STOP", isFromMe: true, senderHandle: "22395" }).filtered, false);
  });
});

describe("otp-filter: subject and edge cases", () => {
  it("subject line is inspected too", () => {
    assert.equal(checkOtp({ subject: "Verification code", text: "448120" }).filtered, true);
    assert.equal(checkOtp({ subject: "Your login code", text: "" }).filtered, true);
  });
  it("curly quotes do not defeat matching", () => {
    assert.equal(isOtpMessage("Don’t share this code: 448120"), true);
  });
  it("non-breaking spaces do not defeat matching", () => {
    assert.equal(isOtpMessage("Your verification code is 448 120"), true);
  });
  it("verdict never echoes the text", () => {
    const v = checkOtp({ text: "Your verification code is 483920." });
    assert.ok(!JSON.stringify(v).includes("483920"));
  });
  it("is pure and deterministic", () => {
    const a = checkOtp({ text: "OTP 445566" });
    const b = checkOtp({ text: "OTP 445566" });
    assert.deepEqual(a, b);
  });
});
