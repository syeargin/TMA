import { runPlanner } from "../lib/comms/planner.js";

/** Every 15 minutes (template.yaml PlannerFunction): queues the scheduled emails that are due on each team. */
export const handler = async () => {
  const result = await runPlanner();
  console.log(JSON.stringify({ msg: "planner run", teams: result.teams, sends: result.sends }));
  return { teams: result.teams, sends: result.sends.length };
};
