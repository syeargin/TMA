import { purgeDue } from "../lib/retention.js";

/** Runs once a day (template.yaml PurgeFunction): deletes archived teams whose 90 days, or 7 days after "Delete team", are up. */
export const handler = async () => {
  const done = await purgeDue();
  console.log(JSON.stringify({ msg: "retention run", deleted: done }));
  return { deleted: done.length };
};
