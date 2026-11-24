---
name: verify-seat-admission
description: Model-check Guard's seat admission (who may join an org, and when) with TLA+ and TLC. Use before you merge a change to how a person joins an org, how an invitation is accepted or canceled, the claim:join lock, the admit() transaction, org creation, or org_seats. Also use when the formal CI job fails.
---

# Verify seat admission

`formal/seat-admission/SeatAdmission.tla` models every order in which org creation, sign-up joins, invitation accepts, cancels, retries and store failures can interleave for one org. TLC checks the rules below in every reachable state. A store failure includes a COMMIT that the server applied but whose reply the client lost.

The main rule is `SeatLimit`. An org never holds more member rows than its `org_seats.seats`. If it breaks, an org holds more people than it pays for, and a Free org goes past its hard cap.

The other rules:

- `OneRowPerPerson`. A person never holds two member rows, because each row takes a seat.
- `NoLostInvitation`. When every request for an invitation has finished, an accepted invitation has its person in the org.
- `FailedAdmissionWritesNothing`. A request that ends refused or failed left no member row. A request whose COMMIT reply was lost (`admissions.ts:239-243`) ends `reply_lost` instead. Its writes were all made, and the client cannot tell it from a failed COMMIT, so the rule does not hold it. The other rules do, retries included: a retry finds the member row and writes no second one.
- `AdmittedMeansMember`. A request that ends admitted has its person in the org.
- `CanceledStaysCanceled`. A canceled invitation never goes back to pending or accepted.

## Run it

Run every config from the repository root:

```sh
formal/check.sh
```

Run one config:

```sh
formal/check.sh formal/seat-admission/current_postgres.cfg
```

The first line of the output says whether the files the model covers still match the sync record (see "When to run it"). You need Java 11 or later, git and curl. If `java` is not on your `PATH`, set `JAVA` to the binary. The first run downloads `tla2tools.jar` v1.7.4 to `~/.cache/vibtra-formal` and stops if its SHA-256 differs from the one in `formal/check.sh`. Set `FORMAL_VERBOSE=1` to print TLC's full output, counterexamples included. A full run takes about 170 seconds on one worker (`FORMAL_WORKERS`, default 1). CI runs the same script in the `formal` job with `FORMAL_WORKERS=auto`.

Each config's first line names its expected result: `\* expect: pass`, or the rule TLC must report as violated. The script prints `ok` for each config that matches. Any other line fails the run. `tests/integration/scripts/formal-replays.test.ts` pins the list of configs, each `expect:` line, the bounds, and the constants in which each replay and finding differs from its `current_*` config. If you add, remove or change a config, change that test in the same pull request. Both are gate files.

Each replay is named after a commit where you can see the bug in the code.

| Config | Expect | What it replays |
|---|---|---|
| `current_postgres` | pass | Today's `createPostgresAdmissions`, every rule. |
| `current_adapter` | pass | Today's `createAdapterAdmissions` (file mode), every rule except the two open findings. |
| `finding_adapter_lost_invitation` | `NoLostInvitation` | Open finding 1. |
| `finding_adapter_member_after_failure` | `FailedAdmissionWritesNothing` | Open finding 2. |
| `replay_ffa2916_hook` | `SeatLimit` | On main until #67 (f533a2f). The accept went through Better Auth's endpoint, where `beforeAcceptInvitation` counted members and a separate insert followed. `Accept = "hook"`. |
| `replay_f533a2f_slug_join` | `SeatLimit` | On main until #68 (f24afde). A sign-up that found its slug taken wrote a member row with no lock and no seat check (f533a2f `claim.ts:351-354`, and `:365-368` after a lost slug race). `SlugJoin = "unchecked"`. |
| `replay_76c1f36_snapshot` | `SeatLimit` | PR #68's first commit, caught in review and never on main. `admit()` ran a plain `BEGIN` (76c1f36 `admissions.ts:156`). On a database whose default isolation is REPEATABLE READ, the lock statement takes the snapshot before the lock is granted. `Isolation = "repeatable read"`. |
| `replay_76c1f36_skip_postgres` | `SeatLimit` | PR #68's first commit, caught in review. Sign-up wrote the organization row before its orgs row (76c1f36 `claim.ts:356`, `:364`), and a join in between skipped the seat check (76c1f36 `admissions.ts:121`, `claim.ts:97`). `NoSeatRow = "skip"`, `CreateOrg = "split"`. |
| `replay_76c1f36_skip_adapter` | `SeatLimit` | The same skip put into today's file-mode `admit()`. Today's adapter `createOrg` still writes the organization row before the orgs row, so `admissions.ts:312` is what keeps file mode safe. `NoSeatRow = "skip"`. |

Read every result, a pass or a counterexample, with the pstack `/statechart` skill. For a violation, it shows the shortest path to the broken rule in plain words. For a pass, it draws how the system moves between states.

## When to run it

Run it when your change touches a function in this table. `formal/seat-admission/sync.txt` records the sync commit and the git blob of each covered file at that commit. `formal/check.sh` compares each covered file with its recorded blob, so the `formal` CI job fails when a covered file changes and the sync does not move. The blobs survive a squash merge. To see what changed since the sync commit, run `git diff <sync commit> -- <covered files>`.

Sync commit: `f10eba827677bbecef6cd5b72ae30b961728d09b`. At that commit, each action in the spec matched the code line its comment names. The covered files are `apps/registry/src/tenancy/admissions.ts`, `apps/registry/src/tenancy/claim.ts`, `apps/registry/src/store/coordination.ts`, `apps/registry/src/auth/better-auth.ts`, `apps/registry/src/console-api/people.ts`, `apps/registry/src/console-api/invitations.ts` and `apps/registry/migrations/0120_org_seats.sql`. The same files select the `formal` job in `tests/selection-map.json`, and `formal-replays.test.ts` checks that both lists and this one match.

| File | Function | Model actions |
|---|---|---|
| `apps/registry/src/tenancy/admissions.ts` | `createPostgresAdmissions.admit` (:185-247), with the lost COMMIT reply at :239-243 | `PgLockStatement` to `PgCommit`, `PgFails` |
| `apps/registry/src/tenancy/admissions.ts` | `seatsIn` (:142-175) | `PgReadSeats` |
| `apps/registry/src/tenancy/admissions.ts` | `createPostgresAdmissions.createOrg` (:249-272) | `CreateInOneTransaction` |
| `apps/registry/src/tenancy/admissions.ts` | `createAdapterAdmissions.admit` (:291-346), with its compensation at :339-343 | `AdLock` to `AdCompensate` |
| `apps/registry/src/tenancy/admissions.ts` | `createAdapterAdmissions.createOrg` (:348-374) | `CreateOrgRow`, `CreateTakesLock`, `CreateSeatRow`, `CreateOwnerRow` |
| `apps/registry/src/tenancy/claim.ts` | `seatRule` (:94-101) | the seat test in `PgReadSeats` and `AdReadSeats` |
| `apps/registry/src/tenancy/claim.ts` | `applyOrgPlan`'s `create` (:347-373) | `JoinBySlug` |
| `apps/registry/src/tenancy/claim.ts` | `claimInvitation` (:407-438) | `OpenInvitation`, and the invitation reads |
| `apps/registry/src/auth/better-auth.ts` | `acceptInvitation` (:466-478), called by `console-api/invitations.ts:47` | `OpenInvitation` |
| `apps/registry/src/store/coordination.ts` | `advisoryLockOf` (:44), `createInProcessCoordinator.lock` (:168-177) | the `lock` variable |
| `apps/registry/src/auth/better-auth.ts` | the `seatsOf` option (:172-175) | `AdReadSeats` |
| `apps/registry/src/console-api/people.ts` | `DELETE /people/invitations/:invitationId` (:278-295) | `Cancel` |
| `apps/registry/migrations/0120_org_seats.sql` | `org_seats`, its trigger, `org_open_seats` | `seatRow`, `PgReadSeats` |

## Keep the model in step

1. Find the action whose comment names the line you changed.
2. Make the action do what the code now does. An action is one atomic step. On Postgres, that is one statement or one COMMIT inside the transaction. In file mode, it is one adapter call. If your change splits one step into two awaits or two statements, split the action. If it joins two steps into one statement or one transaction, join them.
3. Update the file and line in the comment.
4. Run `formal/check.sh`.
5. Once every config gives its expected result and the spec describes the code at your commit, commit your change and run `formal/check.sh --sync`. It writes `HEAD` and the blob of each covered file to `sync.txt`, and it refuses while a covered file has uncommitted changes. Then change the sync commit in this file to match. To cover a new file, add its path as a line of `sync.txt` and to `job:formal` in `tests/selection-map.json`, then run `--sync`.

Change the model in the same pull request as the code. If your change makes a rule fail on `current_postgres` or `current_adapter`, do not edit the rule or the config to make it pass.

## Model bug or code bug

Read the counterexample one step at a time, and open the line that each step's comment names. Then decide which kind of bug it is.

- It is a code bug when every step matches what that line does, and the end state breaks a rule the code promises. Fix the code, or report the bug.
- It is a model bug when some step does something the code cannot do. Examples are a step that writes outside the lock when the code holds it, two statements in one action that the code runs separately, or a store that throws in a step that cannot throw. Fix that action, and say why in the pull request.
- If a replay or a finding starts to pass, the model has lost the ability to see that bug. First check what you changed in the shared actions. If you fixed the finding in the code, move its rule into the `current_*` config, delete the finding config, and list the change in the pull request.

## Open findings

Both findings are in file mode only. Hosted mode refuses to start without `DATABASE_URL` (`apps/registry/src/config.ts:698-705`), and each finding needs a write to the in-memory Better Auth adapter to throw. On Postgres, the transaction rolls back all of these writes together.

1. Lost invitation (`NoLostInvitation`). `adapter.update` at `admissions.ts:322` marks the invitation accepted. Then `adapter.create` of the member at :327 throws. The compensating `adapter.update` at :341 also throws, and its `.catch(() => undefined)` hides that error. The invitation stays accepted with no member row. From then on, `claimInvitation` refuses it as `INVITATION_NOT_FOUND` (`claim.ts:415`).
2. Member row after a failed admission (`FailedAdmissionWritesNothing`). The invitation is accepted at :322 and the member row is created at :327. Then the session `adapter.update` at :333 throws. The compensation at :341 sets the invitation back to pending but leaves the member row, and `admit()` throws. The person is in the org, the request reports a failure, and the invitation shows as pending.

## What the model leaves out

- The bounds are one org, the owner, and three joiners (`a`, `b`, `c`). `a` and `b` are invited, and `a` sends two requests at once. A refused or failed request is sent once more. There are 2 seats. A pass covers these bounds, not every size.
- Seats stay fixed during a run. A lower `user_limit` or a plan change can leave an org above its seats. Admission does not promise against that, and the model does not change seats.
- Removing a member is left out. `console-api/people.ts:200` deletes the member row through Better Auth, outside `claim:join`. It only lowers the count, so `SeatLimit` and `OneRowPerPerson` cannot break through it. It ends a membership on purpose, so `NoLostInvitation` and `AdmittedMeansMember` would have to exempt everyone who was removed. If the removal commits between `admit()`'s member read (`admissions.ts:201-205`) and its COMMIT, `admit()` skips the insert (:222) and returns `admitted` for a person with no row. That is the same end state as the admission finishing first and the removal right after, so it loses no seat and no invitation. A trial model with removal, which exempted removed people from those two rules, grew `current_postgres` to over 21 million distinct states, against 2.5 million without it. It found no violation down to depth 43, where it was stopped after 16 minutes.
- Two sign-ups that create one slug at once are left out: the model has one `Owner`. Today the second one's `createOrg` fails and it joins through `admitOrRefuse` (`claim.ts:367-370`, `admissions.ts:349-358`), the same path as `JoinBySlug`. At f533a2f it wrote an unchecked row (`claim.ts:365-368`), which `replay_f533a2f_slug_join` reaches through `:351-354` instead. This affects `SeatLimit` and `OneRowPerPerson`.
- Invitation expiry (`claim.ts:415`) is left out. It only refuses, so leaving it out adds behaviours and cannot hide a violation of any rule.
- A second invitation to the same person after a cancel is left out: each invited joiner has one invitation. The new invitation is a new row, and the canceled one stays canceled, so `CanceledStaysCanceled` is per row. A request for the new invitation is checked the same way as any other, and the model does not check `NoLostInvitation` or `OneRowPerPerson` across the two.
- Checks outside the lock that can only refuse are left out: `claimInvitation`'s early read (`claim.ts:420-422`) and the domain join's `refuseIfOrgIsFull` (`claim.ts:284`). So is the in-process `serialized` chain (`claim.ts:119-125`). Leaving these out adds behaviours, so it cannot hide a violation.
- `noPeopleLimit`, unlimited seats (`seats` null), read-only orgs (`requireWritableOrg`), roles, and the session row are left out.
- Advisory-lock hash collisions between orgs are left out. They only add waiting.
- The failure paths of `createOrg`, on Postgres (`admissions.ts:249-272`) and in file mode (`:365-371`), are left out.
