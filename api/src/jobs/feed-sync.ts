import { runFeedSync } from "../lib/feed/sync.js";

/** Every 30 minutes (template.yaml FeedSyncFunction): brings each team's imported calendar feed up to date. */
export const handler = async () => {
  const result = await runFeedSync();
  console.log(JSON.stringify({ msg: "feed sync run", ...result }));
  return result;
};
