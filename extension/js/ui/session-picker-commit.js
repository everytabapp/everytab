// Copyright 2026 Hadrien Gelas and EveryTab contributors
// SPDX-License-Identifier: MPL-2.0

import { reportFailure } from "../lib/failure-diagnostic.js";
/**
 * Save the selected Session before applying its optional organization plan.
 * New-Session organization belongs to the creation operation, which knows its ID.
 * @param {{id:string|null,name:string,isNew:boolean}} value
 * @param {object|null} plan
 * @param {(value:object)=>Promise<boolean>|boolean} save
 * @param {(kind:string,plan:object)=>Promise<object>} organize
 * @returns {Promise<boolean>} whether the primary save succeeded
 */
export async function commitSessionPick(value, plan, save, organize) {
  if (value.isNew) {
    const member = plan?.mode === "replace" ? plan.members?.[0] : null;
    const organization = member
      ? { groupIds: member.groupIds ?? [], createNames: member.createNames ?? [] }
      : plan?.mode === "add"
        ? { groupIds: plan.groupIds ?? [], createNames: plan.createNames ?? [] }
        : null;
    return await save({ ...value, ...(organization ? { organization } : {}) }) === true;
  }
  if (await save(value) !== true) return false;
  if (plan) {
    try {
      const result = await organize("session", plan);
      if (result?.ok === false) reportFailure("Session group assignment");
    } catch (error) {
      reportFailure("Session group assignment", error);
    }
  }
  return true;
}
