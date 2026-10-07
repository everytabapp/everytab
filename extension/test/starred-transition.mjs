import { shouldTransitionStarredRail } from "../js/ui/starred-transition.js";

const yes = shouldTransitionStarredRail({ hasApi: true, reduced: false, scrollTop: 0 });
const scrolled = shouldTransitionStarredRail({ hasApi: true, reduced: false, scrollTop: 1 });
const reduced = shouldTransitionStarredRail({ hasApi: true, reduced: true, scrollTop: 0 });
if (!yes || scrolled || reduced) {
  throw new Error(`Unexpected Starred transition ownership: ${JSON.stringify({ yes, scrolled, reduced })}`);
}
console.log("PASS: Starred animates only where sticky occlusion remains stable");
