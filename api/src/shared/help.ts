/**
 * The help guide's topics (the site's /help pages). One list for the site and the API: the site shows
 * them, and the API takes view counts only for these ids. To add or change a topic, edit this file;
 * screenshots are made by web/scripts/help-shots.mjs against the preview server.
 *
 * In `steps` and `tips`, **text** is a button or label exactly as the site shows it.
 */
import type { Feature } from "./features.js";
import type { Role } from "./permissions.js";

/** Who a topic is for. People can be more than one (a coach who's also a parent). */
export const HELP_ROLES = ["parent", "staff", "admin"] as const;
export type HelpRole = (typeof HELP_ROLES)[number];
export const HELP_ROLE_LABELS: Record<HelpRole, string> = {
  parent: "Parents",
  staff: "Coaches and coordinators",
  admin: "Team admins and finance"
};

/** Which help roles a team role reads. */
export function helpRolesFor(roles: readonly string[]): HelpRole[] {
  const out = new Set<HelpRole>();
  for (const r of roles as Role[]) {
    if (r === "parent") out.add("parent");
    if (r === "coach" || r === "coordinator" || r === "food") out.add("staff");
    if (r === "admin" || r === "finance") out.add("admin");
  }
  return HELP_ROLES.filter((r) => out.has(r));
}

/**
 * Where a topic's contextual help (the "?" button on a team) shows it: the team page, and for a
 * tournament its section ("tournament" alone is the game-day sheet).
 */
export type HelpPlace = "home" | "schedule" | "tournaments" | "tournament" | "tournament:ref" | "tournament:meals" | "tournament:travel"
  | "fund" | "roster" | "info" | "members" | "communications" | "account" | "email";

export type HelpTopic = {
  id: string;
  title: string;
  role: HelpRole;
  /** One sentence for search results and lists. */
  summary: string;
  /** Other words people search with. */
  keywords: string[];
  steps: string[];
  tips?: string[];
  /** Screenshot under the site's /help/ folder, and what it shows (its alt text). */
  shot?: { file: string; alt: string };
  /** "Take me there": a page on the team (relative to /teams/<id>/) or an absolute path. */
  go?: { label: string; path: string };
  /** The team feature it needs; when the team has it off, the topic says so. */
  feature?: Feature;
  places: HelpPlace[];
  related: string[];
};

export const HELP_TOPICS: HelpTopic[] = [
  // ——— Parents ———
  {
    id: "join-team", role: "parent", title: "Join your team from the invite email",
    summary: "Create your account with the address the invite went to, and the team shows up on Your teams.",
    keywords: ["invite", "sign up", "signup", "create account", "register", "join", "login", "log in", "password", "code", "verify"],
    steps: [
      "Open the email “You're invited to …” from Teem Hub and tap **Accept the invite**.",
      "Create your account with the same email address the invite was sent to. Choose a password.",
      "We email you a code. Enter it to confirm your address.",
      "Read and accept the privacy notice. Your team now appears on **Your teams**.",
      "Already have an account with that address? Just **Sign in**: the new team appears on Your teams."
    ],
    tips: [
      "The invite works only for the address it was sent to, and it expires. If it ran out, ask the coach or team coordinator to send a new one.",
      "Can't find the email? Check spam or promotions, then ask your coordinator to use **Email again** on the Members tab."
    ],
    shot: { file: "join-team.jpg", alt: "The Your teams page after joining, with the team listed" },
    go: { label: "Create your account", path: "/signup" },
    places: ["home", "email"], related: ["change-emails", "answer-availability"]
  },
  {
    id: "answer-availability", role: "parent", title: "Answer In, Maybe or Out",
    summary: "Tell the coach whether your player is coming, on the schedule or straight from the reminder email.",
    keywords: ["rsvp", "availability", "attend", "attending", "coming", "going", "absent", "miss", "yes", "no", "respond", "reply", "reminder"],
    steps: [
      "Open the team's **Schedule** tab.",
      "Find the practice or event and tap **In**, **Maybe** or **Out** under your player's name. It saves right away.",
      "Changed your mind? Tap a different answer. Tap the one you chose again to clear it.",
      "From the reminder email: tap **In**, **Maybe** or **Out** in the email, then tap the button on the page that opens to confirm. You don't need to sign in."
    ],
    tips: [
      "The counts next to each date (“8 in · 1 maybe · 2 out”) show the whole team. Tap them to see who answered.",
      "More than one player on the team? Each one has their own buttons."
    ],
    shot: { file: "answer-availability.jpg", alt: "A practice on the schedule with the In, Maybe and Out buttons" },
    go: { label: "Open the schedule", path: "schedule" },
    places: ["schedule", "home", "email"], related: ["add-to-calendar", "see-answers"]
  },
  {
    id: "add-to-calendar", role: "parent", title: "Add the schedule to your phone's calendar",
    summary: "Add one practice, event or tournament, or every date in a repeating practice series, to your calendar.",
    keywords: ["calendar", "ical", "ics", "subscribe", "save", "iphone", "apple", "google", "android", "outlook", "phone", "export"],
    steps: [
      "Open the **Schedule** tab, or a tournament's page.",
      "Tap **📅 Add to calendar** on the date you want.",
      "Choose your calendar: **Apple (iPhone, Mac)**, **Google / Android**, **Outlook.com** or **Outlook (work or school)**.",
      "For a repeating practice, choose from **Every date in the series** to add them all at once."
    ],
    tips: [
      "What you add is a copy: if the coach changes or cancels a date later, your calendar won't update. The Teem Hub schedule is always the latest.",
      "Using Outlook on a computer? Choose **Download .ics (Outlook desktop)** and open the file."
    ],
    shot: { file: "add-to-calendar.jpg", alt: "The Add to calendar menu with Apple, Google and Outlook choices" },
    go: { label: "Open the schedule", path: "schedule" },
    places: ["schedule", "tournament"], related: ["answer-availability", "game-day-sheet"]
  },
  {
    id: "game-day-sheet", role: "parent", title: "Find the game-day sheet",
    summary: "Arrival time, court, uniform, what to bring and the tournament rules, all on the tournament's page.",
    keywords: ["tournament", "arrive", "arrival", "court", "uniform", "jersey", "wave", "address", "directions", "rules", "bring", "game day", "match"],
    steps: [
      "Open the **Tournaments** tab and tap the tournament.",
      "The **Game-day sheet** is the first section: when to arrive, where, the court and the uniform.",
      "Scroll for **What to bring** and **Tournament rules**.",
      "Tap an address to open directions, or a code to copy it."
    ],
    tips: ["The coach updates the sheet as the club posts courts and waves, so check it the night before."],
    shot: { file: "game-day-sheet.jpg", alt: "A tournament's game-day sheet with arrival, court and uniform" },
    go: { label: "Open tournaments", path: "tournaments" },
    places: ["tournaments", "tournament"], related: ["travel-plans", "meal-signup", "add-to-calendar"]
  },
  {
    id: "travel-plans", role: "parent", title: "Add travel plans for a tournament",
    summary: "Say how you're getting there and where you're staying, so the coordinator knows who's covered.",
    keywords: ["travel", "hotel", "lodging", "room", "stay", "drive", "driving", "flight", "carpool", "trip", "overnight"],
    steps: [
      "Open the **Tournaments** tab, tap the tournament, then **Travel**.",
      "**Team hotel** shows where the team is staying and the booking details.",
      "Tap **Add** with your player's name (for example “Add Ava's travel”).",
      "Fill in how you're getting there and where you're staying, then tap **Save travel plans**.",
      "To change them later, tap **Update** with your player's name."
    ],
    tips: ["Travel shows only for tournaments the coach marked as travel tournaments."],
    shot: { file: "travel-plans.jpg", alt: "A tournament's Travel section with the team hotel and families' plans" },
    go: { label: "Open tournaments", path: "tournaments" },
    feature: "travel", places: ["tournament:travel", "tournament"], related: ["game-day-sheet", "meal-signup"]
  },
  {
    id: "meal-signup", role: "parent", title: "Sign up to bring a meal",
    summary: "Pick an open team meal at a tournament and say your family will take it.",
    keywords: ["meal", "food", "snack", "snacks", "lunch", "dinner", "breakfast", "potluck", "bring food", "volunteer", "sign up"],
    steps: [
      "Open the **Tournaments** tab, tap the tournament, then **Meals**.",
      "Find a meal no one has taken yet and tap **We'll take it**.",
      "Changed plans? Tap **Release** on your meal so another family can take it."
    ],
    tips: ["The food coordinator sees who has every meal, and the weekly email lists meals still open."],
    shot: { file: "meal-signup.jpg", alt: "A tournament's meals with one open meal and the We'll take it button" },
    go: { label: "Open tournaments", path: "tournaments" },
    feature: "meals", places: ["tournament:meals", "tournament"], related: ["game-day-sheet", "travel-plans"]
  },
  {
    id: "record-payment", role: "parent", title: "Record a dues payment you sent",
    summary: "Send the money the way your coordinator asks, then record it so finance can confirm it.",
    keywords: ["dues", "pay", "payment", "paid", "money", "fee", "fees", "venmo", "zelle", "check", "cash", "fund", "owe", "balance"],
    steps: [
      "Send your payment the way the coordinator asked (for example Venmo or a check).",
      "Open the **Team Fund** tab and tap **Record a payment**.",
      "Enter the amount, the date you sent it and what it's for (usually **Dues**), then tap **Record payment**.",
      "It shows under **Waiting to be confirmed** until finance marks it received. Then it's in your entries and your dues balance updates."
    ],
    tips: ["Bought something for the team? Use **Request reimbursement** on the same tab."],
    shot: { file: "record-payment.jpg", alt: "The Team Fund tab with the Record a payment button and your dues" },
    go: { label: "Open the team fund", path: "fund" },
    feature: "fund", places: ["fund"], related: ["confirm-payment", "change-emails"]
  },
  {
    id: "change-emails", role: "parent", title: "Change which emails you get",
    summary: "Turn each kind of team email on or off for yourself, team by team.",
    keywords: ["email", "emails", "notifications", "unsubscribe", "stop", "too many", "spam", "weekly", "reminder", "settings", "opt out"],
    steps: [
      "On **Your teams**, tap **Your account** at the bottom of the page.",
      "Under **Emails from your teams**, tick the emails you want and untick the ones you don't. Changes save right away.",
      "Or use the unsubscribe link at the bottom of any team email to stop just that kind."
    ],
    tips: [
      "Invites and account notices always go, so you can sign in and keep your account safe.",
      "“Your team hasn't turned this on yet” means the team doesn't send that email at all."
    ],
    shot: { file: "change-emails.jpg", alt: "Your account page with the Emails from your teams checkboxes" },
    go: { label: "Open your account", path: "/account" },
    places: ["account", "email"], related: ["communications", "join-team"]
  },

  // ——— Coaches and coordinators ———
  {
    id: "add-practice", role: "staff", title: "Add a practice or a repeating series",
    summary: "Add one practice, or a series that repeats every week (or every 2 or 3) until a date you pick.",
    keywords: ["practice", "add", "create", "new", "repeat", "repeating", "recurring", "weekly", "series", "event", "schedule", "time", "gym"],
    steps: [
      "Open the **Schedule** tab and tap **Add practice** (or **Add event** or **Add tournament**).",
      "Fill in the date, start and end times and the place.",
      "To repeat it, under **Repeat** choose **Every week** (or every 2 or 3 weeks), tick the days and set **Ends on**.",
      "Leave **Skip tournament days** ticked so practices don't land on tournament weekends. The line under it shows how many dates you'll get.",
      "Save. Every date appears on the schedule for families to answer."
    ],
    tips: ["Practice uniform colors come from **Team info › Team settings**."],
    shot: { file: "add-practice.jpg", alt: "The Add practice form with the Repeat options" },
    go: { label: "Open the schedule", path: "schedule" },
    places: ["schedule"], related: ["change-series", "take-attendance"]
  },
  {
    id: "change-series", role: "staff", title: "Cancel or change one date of a series",
    summary: "Call off one practice, or change one date, the dates from here on, or the whole series.",
    keywords: ["cancel", "cancelled", "change", "move", "reschedule", "edit", "one date", "series", "delete", "weather", "closed", "time change"],
    steps: [
      "On the **Schedule** tab, find the date you want to change.",
      "To call it off, tap **Cancel this date** under it. Families see it as cancelled and don't need to answer. Tap **Restore this date** to undo.",
      "To change it, tap **Edit** and choose **This date only**, **This and following dates** or **Whole series**.",
      "Save. Answers families already gave stay as they were."
    ],
    tips: [
      "Changes to the whole series skip dates you changed one at a time.",
      "If the team's schedule comes from the club's calendar, changes there sync in on their own."
    ],
    shot: { file: "change-series.jpg", alt: "A practice's menu with Cancel this date and the Edit choices" },
    go: { label: "Open the schedule", path: "schedule" },
    places: ["schedule"], related: ["add-practice", "post-announcement"]
  },
  {
    id: "take-attendance", role: "staff", title: "Take practice attendance",
    summary: "Mark who came to practice. It starts from families' answers, so most of it is filled in already.",
    keywords: ["attendance", "roll", "roll call", "present", "absent", "late", "excused", "check in", "who came"],
    steps: [
      "On the **Schedule** tab, find today's (or a past) practice and tap **Take attendance**.",
      "Each player starts from their family's answer: In shows as Present, Out as Excused.",
      "Tap to change anyone: **Present**, **Late**, **Excused** or **Absent**. Add a note if you like.",
      "Tap **Rest present** to mark everyone left as present, then save."
    ],
    tips: ["Each player's percentage is on the **Roster** tab. Families see only their own player's."],
    shot: { file: "take-attendance.jpg", alt: "The attendance sheet with Present, Late and Excused for each player" },
    go: { label: "Open the schedule", path: "schedule" },
    feature: "attendance", places: ["schedule", "roster"], related: ["see-answers", "add-practice"]
  },
  {
    id: "see-answers", role: "staff", title: "See who hasn't answered, and answer for a family",
    summary: "Check the replies for any date, and mark a player In, Maybe or Out when a parent tells you in person.",
    keywords: ["who", "answers", "no reply", "missing", "not answered", "availability", "headcount", "count", "rsvp", "remind", "nudge", "answer for"],
    steps: [
      "On the **Schedule** tab, tap the counts next to a date (“8 in · 1 maybe · 2 out · 3 no reply”).",
      "The list shows every player's answer. **No answer** means the family hasn't replied.",
      "To answer for a family, tap **In**, **Maybe** or **Out** next to their player.",
      "To nudge everyone at once, turn on the **Availability reminder** under Communications."
    ],
    tips: ["The weekly **Staff digest** also lists who hasn't answered."],
    shot: { file: "see-answers.jpg", alt: "A date's availability list showing each player's answer" },
    go: { label: "Open the schedule", path: "schedule" },
    places: ["schedule", "home"], related: ["answer-availability", "communications"]
  },
  {
    id: "post-announcement", role: "staff", title: "Post an announcement and email it",
    summary: "Post news on the team's Home page, and email it to the team when it matters.",
    keywords: ["announcement", "announce", "post", "message", "news", "notify", "email the team", "pin", "update", "broadcast"],
    steps: [
      "Open the team's **Home** tab and tap **Post** next to Announcements.",
      "Write the announcement.",
      "Tick **Also email the team** to send it by email too.",
      "Tap **Post**. Pin it if it should stay at the top."
    ],
    tips: ["**Also email the team** shows when the team has **Announcement emails** turned on in Communications."],
    shot: { file: "post-announcement.jpg", alt: "The Post an announcement sheet with Also email the team" },
    go: { label: "Open Home", path: "" },
    places: ["home"], related: ["communications", "change-series"]
  },
  {
    id: "ref-jobs", role: "staff", title: "Assign ref jobs",
    summary: "Fill each family's work duties at a tournament, by rotation or by hand.",
    keywords: ["ref", "refs", "referee", "work", "duty", "duties", "line judge", "scorebook", "scorekeeper", "rotation", "jobs", "assign"],
    steps: [
      "Open the **Tournaments** tab, tap the tournament, then **Ref jobs**.",
      "Tap **Fill by rotation** to share the jobs (book, score, lines and so on) out across each group.",
      "Change any job by hand in the list.",
      "Two groups working courts separately? Tap **Edit A/B groups** and put each player in A or B."
    ],
    tips: ["Families see their own jobs in the tournament packet email before the tournament."],
    shot: { file: "ref-jobs.jpg", alt: "A tournament's ref jobs with Fill by rotation" },
    go: { label: "Open tournaments", path: "tournaments" },
    feature: "refjobs", places: ["tournament:ref", "tournament"], related: ["game-day-sheet", "communications"]
  },
  {
    id: "invite-families", role: "staff", title: "Invite families, and send invites that are waiting",
    summary: "Invite people one at a time or from a spreadsheet, then email the invites that haven't gone out yet.",
    keywords: ["invite", "add parent", "add family", "add coach", "members", "import", "spreadsheet", "excel", "upload", "resend", "pending", "roles", "access"],
    steps: [
      "Open the **Members** tab.",
      "One person: under **Invite someone**, enter their name and email, tick their roles, and for parents pick their family. Leave **Email the invite now** ticked and tap **Send invite**.",
      "From a spreadsheet: under **Import from a spreadsheet**, choose the file, tap **Preview**, check it and import. Imported invites are saved but not emailed yet.",
      "Under **Pending invites**, tap **Email them now** to send every invite that's waiting, or **Email invite** for one.",
      "Didn't get it? Tap **Email again** next to that invite."
    ],
    tips: ["Only team admins can invite people and set roles."],
    shot: { file: "invite-families.jpg", alt: "The Members tab with Invite someone and Pending invites" },
    go: { label: "Open Members", path: "members" },
    places: ["members", "roster"], related: ["join-team", "team-features"]
  },

  // ——— Team admins and finance ———
  {
    id: "team-features", role: "admin", title: "Turn team features on or off",
    summary: "Hide what your team doesn't use, like meals or ref jobs. Nothing is deleted.",
    keywords: ["features", "settings", "turn off", "turn on", "hide", "disable", "enable", "meals", "fund", "travel", "ref jobs", "attendance", "handbook", "tabs"],
    steps: [
      "Open **Team info** and tap **Team settings**.",
      "Under **Features**, untick what your team doesn't use. It disappears for everyone, and changes save right away.",
      "Tick it again to bring it back. Everything is still there."
    ],
    tips: ["A feature that says “Not included for your club” can only be turned on by a site owner."],
    shot: { file: "team-features.jpg", alt: "Team settings with the Features checkboxes" },
    go: { label: "Open Team info", path: "info" },
    places: ["info"], related: ["communications", "invite-families"]
  },
  {
    id: "communications", role: "admin", title: "Set up the weekly email and reminders",
    summary: "Choose which emails the team sends, when, and to whom, and preview them first.",
    keywords: ["communications", "weekly", "email", "digest", "reminder", "reminders", "schedule email", "pause", "preview", "test", "dues reminder", "packet"],
    steps: [
      "Open **Team info** and tap **Communications**.",
      "Each email (like **Weekly at-a-glance**, **Availability reminder** or **Dues reminder**) has an **On** switch. Turn on the ones you want.",
      "Pick the day and time, under **Every** and **At**, for emails that go on a schedule.",
      "Tap **Preview** to see the email, or **Send me a test** to get one yourself.",
      "**Upcoming** shows what's going out next; **Delivery health** shows emails that bounced."
    ],
    tips: ["Going on a break? Pause the team's emails until a date. Invites and account notices still go."],
    shot: { file: "communications.jpg", alt: "The Communications page with each email's switch and schedule" },
    go: { label: "Open Communications", path: "communications" },
    places: ["communications", "info"], related: ["change-emails", "post-announcement"]
  },
  {
    id: "confirm-payment", role: "admin", title: "Confirm a payment and see dues by family",
    summary: "Mark families' payments received, and see who's paid and who still owes.",
    keywords: ["confirm", "received", "payment", "dues", "ledger", "who paid", "owe", "balance", "finance", "treasurer", "reimbursement", "money"],
    steps: [
      "Open the **Team Fund** tab.",
      "Under **Waiting for you to confirm**, check each payment against what you received, then tap **Received** (or **Paid back** for a reimbursement).",
      "Tap **Decline** if it didn't arrive. It stays in the ledger marked declined.",
      "**Dues by family** shows what each family has paid and still owes. The **Ledger** lists every entry."
    ],
    tips: ["Families get a **Payment recorded** email when you confirm, if the team has it on."],
    shot: { file: "confirm-payment.jpg", alt: "The Team Fund tab with payments waiting and dues by family" },
    go: { label: "Open the team fund", path: "fund" },
    feature: "fund", places: ["fund"], related: ["record-payment", "communications"]
  }
];

export const HELP_IDS = new Set(HELP_TOPICS.map((t) => t.id));

/** Shown as "Most used" until a role has this many views; after that, the counts decide. */
export const POPULAR_MIN_VIEWS = 50;
export const STARTER_PICKS: Record<HelpRole | "all", string[]> = {
  all: ["answer-availability", "add-to-calendar", "game-day-sheet", "join-team", "add-practice"],
  parent: ["answer-availability", "add-to-calendar", "game-day-sheet", "record-payment", "join-team"],
  staff: ["add-practice", "change-series", "see-answers", "post-announcement", "invite-families"],
  admin: ["communications", "confirm-payment", "team-features", "invite-families", "post-announcement"]
};

/** How a topic was opened, for the counts. */
export const HELP_VIA = ["browse", "search", "popular", "context", "related", "link"] as const;
export type HelpVia = (typeof HELP_VIA)[number];
