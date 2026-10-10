/**
 * Weekly practice times (settings.practices) → practice events, once per team.
 *
 * Each weekly practice becomes a repeating practice event with id "pr-<practice id>". Answers were keyed
 * "pr-<practice id>-<date>" and a series' dates are keyed "<event id>-<date>", so families' answers carry
 * over without being touched. Cancelled dates move from settings.cancelled onto the event.
 */
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "./db.js";
import { keys } from "./keys.js";
import { getItem, ID, now } from "../api/util.js";

type Practice = { id: string; label?: string; dow: number; start?: string; end?: string; from?: string; until?: string; location?: string; note?: string; court?: string; uniformColor?: string };

/** Club seasons run August to June: a practice with no last date stops on June 30. Same rule as the site. */
export function seasonEnd(from: string): string {
  const [y, m] = from.split("-").map(Number);
  return `${m >= 7 ? y + 1 : y}-06-30`;
}

/** The first date on or after `from` that falls on weekday `dow` (0 = Sunday). */
export function firstOnOrAfter(from: string, dow: number): string {
  const d = new Date(`${from}T12:00:00Z`);
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));

/** The practice event a weekly practice turns into. */
export function practiceEvent(teamId: string, p: Practice, cancelledKeys: string[], by: string, at: string) {
  const eid = `pr-${p.id}`;
  const until = p.until || seasonEnd(p.from!);
  const date = firstOnOrAfter(p.from!, Number(p.dow));
  const prefix = `${eid}-`;
  return {
    eid,
    item: defined({
      ...keys.event(teamId, eid), type: "Event", kind: "practice", title: p.label || "Practice", date,
      time: p.start, endTime: p.end, location: p.location, court: p.court, uniformColor: p.uniformColor, notes: p.note, travel: false,
      repeat: { every: 1, days: [Number(p.dow)], until: until < date ? date : until, skipTournaments: true },
      cancelled: cancelledKeys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
      GSI2PK: `TEAM#${teamId}#CAL`, GSI2SK: `${date}#${eid}`, updatedAt: at, updatedBy: by, convertedFrom: "practice-times"
    })
  };
}

/**
 * Converts a team's weekly practice times. Safe to call twice at once: the settings update only succeeds while
 * the practices are still there, and each event is written only if it doesn't exist yet.
 */
export async function convertPractices(teamId: string, by: string): Promise<{ converted: number; skipped: string[] }> {
  const settings = await getItem(keys.settings(teamId));
  const practices = ((settings?.practices ?? []) as Practice[]).filter((p) => p && p.id);
  if (!settings || !practices.length) return { converted: 0, skipped: [] };
  const at = now();
  const cancelled = (settings.cancelled ?? []) as string[];
  const usable = practices.filter((p) => p.from && ID.test(`pr-${p.id}`));
  const skipped = practices.filter((p) => !usable.includes(p)).map((p) => p.label || p.id);
  const events = usable.map((p) => practiceEvent(teamId, p, cancelled, by, at));
  const keep = cancelled.filter((k) => !usable.some((p) => k.startsWith(`pr-${p.id}-`)));
  // DynamoDB transactions take up to 100 actions; a team has at most 20 practices.
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: TABLE, Key: keys.settings(teamId),
        UpdateExpression: "SET practices = :none, cancelled = :keep, practicesConvertedAt = :at, updatedAt = :at",
        ConditionExpression: "size(practices) = :n",
        ExpressionAttributeValues: { ":none": [], ":keep": keep, ":at": at, ":n": practices.length }
      } },
      ...events.map((e) => ({ Put: { TableName: TABLE, Item: e.item, ConditionExpression: "attribute_not_exists(PK)" } }))
    ] }));
  } catch (e) {
    const name = (e as { name?: string }).name;
    // Someone else converted (or changed the practices) at the same moment.
    if (name === "TransactionCanceledException" || name === "ConditionalCheckFailedException") return { converted: 0, skipped: [] };
    throw e;
  }
  return { converted: events.length, skipped };
}
