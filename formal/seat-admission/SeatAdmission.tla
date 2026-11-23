--------------------------- MODULE SeatAdmission ---------------------------
(***************************************************************************)
(* One organisation, its seats, and the requests that try to take them.   *)
(*                                                                         *)
(* Each action is one atomic step of the code: one SQL statement or one    *)
(* COMMIT on Postgres, one adapter call in file mode. The comment above    *)
(* each action names the file and line, from apps/registry/src unless it   *)
(* says otherwise. A step with no effect on these variables (the session   *)
(* UPDATE, the role lookup) is folded into the next step. Checks the code  *)
(* makes outside the org lock that can only refuse (claimInvitation's      *)
(* early read at tenancy/claim.ts:420-422, the domain join's               *)
(* refuseIfOrgIsFull at tenancy/claim.ts:284) are left out: leaving out a  *)
(* refusal adds behaviours, so it cannot hide a violation.                 *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Owner,       \* the person whose sign-up creates the org
    Joiners,     \* everyone else who tries to get in
    Invited,     \* the joiners an admin has invited
    Twice,       \* joiners who send a second request at the same time (a double click, a second tab)
    Retries,     \* how many times a refused, failed or reply_lost request is sent again
    Seats,       \* org_seats.seats (migration 0120); fixed for the run
    Impl,        \* "postgres": createPostgresAdmissions; "adapter": createAdapterAdmissions (file mode)
    Accept,      \* "admit": claimInvitation calls Admissions.admit; "hook": Better Auth accept-invitation with beforeAcceptInvitation (ffa2916)
    Isolation,   \* admit()'s Postgres isolation: "read committed" (today, admissions.ts:65); "repeatable read" (76c1f36's plain BEGIN on a database whose default is REPEATABLE READ)
    NoSeatRow,   \* what admit() does when the org has no orgs/org_seats row: "refuse" (today) or "skip" (76c1f36)
    CreateOrg,   \* "one transaction" (Postgres createOrg), "locked" (adapter createOrg), "split" (76c1f36 applyOrgPlan)
    SlugJoin,    \* a sign-up that finds its slug taken: "admit" goes through admit() (today); "unchecked" writes the member row with no lock and no seat check (f533a2f)
    WritesFail   \* TRUE: any store write may throw

People == {Owner} \cup Joiners
Requests == People \cup {<<j, 2>> : j \in Twice}
Who(r) == IF r \in People THEN r ELSE r[1]
Terminal == {"created", "admitted", "refused", "failed", "reply_lost"}
InTransaction == {"pg_read_inv", "pg_read_member", "pg_read_seats", "pg_accept", "pg_insert", "pg_commit"}

ASSUME Owner \notin Joiners /\ Invited \subseteq Joiners /\ Twice \subseteq Joiners
ASSUME Retries \in Nat /\ Seats \in Nat
ASSUME Impl \in {"postgres", "adapter"} /\ Accept \in {"admit", "hook"}
ASSUME Isolation \in {"read committed", "repeatable read"} /\ NoSeatRow \in {"refuse", "skip"}
ASSUME CreateOrg \in {"one transaction", "locked", "split"} /\ WritesFail \in BOOLEAN /\ SlugJoin \in {"admit", "unchecked"}

VARIABLES
    orgRow,    \* the Better Auth "organization" row exists, so findOrgBySlug finds the org
    seatRow,   \* the "orgs" row and its "org_seats" row exist (trigger orgs_seats_on_create, migration 0120)
    rows,      \* "member" rows per person in this org; nothing makes (organizationId, userId) unique
    inv,       \* "invitation".status per invited joiner
    lock,      \* the request holding claim:join:<orgId>, or {}: pg_advisory_xact_lock on Postgres, the in-process coordinator in file mode
    pc,        \* each request's next step
    path,      \* how each request got in line: "join" (findOrgBySlug) or "invitation" (claimInvitation)
    snap,      \* the REPEATABLE READ snapshot an admit() transaction reads from
    already,   \* admit() found the person already a member
    txn,       \* Postgres writes made inside the open admit() transaction, applied at COMMIT
    wrote,     \* this attempt of the request has a member row in the store
    tries      \* how many times the request has been sent again

vars == <<orgRow, seatRow, rows, inv, lock, pc, path, snap, already, txn, wrote, tries>>
store == <<orgRow, seatRow, rows, inv>>

RECURSIVE Total(_, _)
Total(f, S) == IF S = {} THEN 0 ELSE LET x == CHOOSE y \in S : TRUE IN f[x] + Total(f, S \ {x})

Members == Total(rows, People)
NoRows == [p \in People |-> 0]
AllPending == [i \in Invited |-> "pending"]
EmptyView == [seatRow |-> FALSE, rows |-> NoRows, inv |-> AllPending]
NoTxn == [member |-> FALSE, accept |-> FALSE]
Committed == [seatRow |-> seatRow, rows |-> rows, inv |-> inv]
Seen(r) == IF Isolation = "repeatable read" THEN snap[r] ELSE Committed
CreatorDone == pc[Owner] \in Terminal
ByInvitation(r) == path[r] = "invitation"

Entry(how) ==
    IF how = "invitation" /\ Accept = "hook" THEN "hk_read_inv"
    ELSE IF Impl = "postgres" THEN "pg_lock" ELSE "ad_lock"

Goto(r, step) ==
    /\ pc' = [pc EXCEPT ![r] = step]
    /\ UNCHANGED <<lock, snap, txn, path>>

Finish(r, outcome) ==
    /\ pc' = [pc EXCEPT ![r] = outcome]
    /\ lock' = lock \ {r}
    /\ snap' = [snap EXCEPT ![r] = EmptyView]
    /\ txn' = [txn EXCEPT ![r] = NoTxn]
    /\ path' = [path EXCEPT ![r] = IF r = Owner THEN "join" ELSE "none"]

AddRow(r) ==
    /\ rows' = [rows EXCEPT ![Who(r)] = @ + 1]
    /\ wrote' = [wrote EXCEPT ![r] = TRUE]

Init ==
    /\ orgRow = FALSE
    /\ seatRow = FALSE
    /\ rows = NoRows
    /\ inv = AllPending
    /\ lock = {}
    /\ pc = [r \in Requests |-> IF r = Owner THEN "create" ELSE "start"]
    /\ path = [r \in Requests |-> IF r = Owner THEN "join" ELSE "none"]
    /\ snap = [r \in Requests |-> EmptyView]
    /\ already = [r \in Requests |-> FALSE]
    /\ txn = [r \in Requests |-> NoTxn]
    /\ wrote = [r \in Requests |-> FALSE]
    /\ tries = [r \in Requests |-> 0]

-----------------------------------------------------------------------------
(* Creating the org: the owner's sign-up.                                 *)

\* tenancy/admissions.ts:249-272 createPostgresAdmissions.createOrg: the organization row, the orgs row (and org_seats,
\* by trigger) and the owner's member row in one READ COMMITTED transaction. Nobody can see any of it before COMMIT,
\* so the transaction is one step.
CreateInOneTransaction ==
    /\ CreateOrg = "one transaction"
    /\ pc[Owner] = "create"
    /\ lock = {}
    /\ orgRow' = TRUE
    /\ seatRow' = TRUE
    /\ AddRow(Owner)
    /\ pc' = [pc EXCEPT ![Owner] = "created"]
    /\ UNCHANGED <<inv, lock, path, snap, already, txn, tries>>

\* "locked": tenancy/admissions.ts:359 adapter.create organization, under claim:create:<slug>, which only creators take.
\* "split": 76c1f36 tenancy/claim.ts:356 applyOrgPlan, ctx.members.createOrg.
CreateOrgRow ==
    /\ CreateOrg \in {"locked", "split"}
    /\ pc[Owner] = "create"
    /\ orgRow' = TRUE
    /\ pc' = [pc EXCEPT ![Owner] = IF CreateOrg = "locked" THEN "c_lock" ELSE "c_seats"]
    /\ UNCHANGED <<seatRow, rows, inv, lock, path, snap, already, txn, wrote, tries>>

\* tenancy/admissions.ts:364 locks.lock(claim:join:<new org id>).
CreateTakesLock ==
    /\ pc[Owner] = "c_lock"
    /\ lock = {}
    /\ lock' = {Owner}
    /\ pc' = [pc EXCEPT ![Owner] = "c_seats"]
    /\ UNCHANGED <<store, path, snap, already, txn, wrote, tries>>

\* "locked": tenancy/admissions.ts:366 options.orgs.createOrg.
\* "split": 76c1f36 tenancy/claim.ts:364 applyOrgPlan, ctx.orgs.createOrg, then :371 admitMember(owner) through admit().
CreateSeatRow ==
    /\ pc[Owner] = "c_seats"
    /\ seatRow' = TRUE
    /\ pc' = [pc EXCEPT ![Owner] = IF CreateOrg = "locked" THEN "c_owner" ELSE Entry("join")]
    /\ UNCHANGED <<orgRow, rows, inv, lock, path, snap, already, txn, wrote, tries>>

\* tenancy/admissions.ts:371 adapter.create member (owner). The lock goes when the callback settles
\* (store/coordination.ts:172-176).
CreateOwnerRow ==
    /\ pc[Owner] = "c_owner"
    /\ AddRow(Owner)
    /\ lock' = {}
    /\ pc' = [pc EXCEPT ![Owner] = "created"]
    /\ UNCHANGED <<orgRow, seatRow, inv, path, snap, already, txn, tries>>

-----------------------------------------------------------------------------
(* Getting in line.                                                        *)

\* tenancy/claim.ts:349-350: a sign-up planned to create the org finds its slug taken and calls admitOrRefuse(existing.id).
\* A domain join (tenancy/claim.ts:268-285, :342-344) finds the org through its orgs row, which is never earlier.
\* 76c1f36 tenancy/claim.ts:347-348 is the same, through admitMember.
\* f533a2f tenancy/claim.ts:351-352: the same findOrgBySlug, then the unchecked write in SlugInsert.
JoinBySlug(r) ==
    /\ pc[r] = "start"
    /\ orgRow
    /\ path' = [path EXCEPT ![r] = "join"]
    /\ pc' = [pc EXCEPT ![r] = IF SlugJoin = "unchecked" THEN "slug_insert" ELSE Entry("join")]
    /\ UNCHANGED <<store, lock, snap, already, txn, wrote, tries>>

\* console-api/invitations.ts:46 calls acceptInvitation (auth/better-auth.ts:466-478), which calls tenancy/claim.ts:407
\* claimInvitation. An admin invites only once the org exists.
OpenInvitation(r) ==
    /\ pc[r] = "start"
    /\ Who(r) \in Invited
    /\ CreatorDone
    /\ path' = [path EXCEPT ![r] = "invitation"]
    /\ pc' = [pc EXCEPT ![r] = Entry("invitation")]
    /\ UNCHANGED <<store, lock, snap, already, txn, wrote, tries>>

\* The person tries again: orgStillBeingSetUp says "Try again in a moment", and a 500 invites the same.
SendAgain(r) ==
    /\ r # Owner
    /\ pc[r] \in {"refused", "failed", "reply_lost"}
    /\ tries[r] < Retries
    /\ tries' = [tries EXCEPT ![r] = @ + 1]
    /\ pc' = [pc EXCEPT ![r] = "start"]
    /\ path' = [path EXCEPT ![r] = "none"]
    /\ already' = [already EXCEPT ![r] = FALSE]
    /\ wrote' = [wrote EXCEPT ![r] = FALSE]
    /\ UNCHANGED <<store, lock, snap, txn>>

\* f533a2f tenancy/claim.ts:353 ctx.members.addMember: one insert, with no claim:join lock and no seat check. The
\* in-process serialized chain (:382) orders it after other sign-ups in the same process only. f533a2f :367 made the same
\* write when createOrg lost a race for the slug; the model has one creator, so it reaches the write only through :353.
SlugInsert(r) ==
    /\ pc[r] = "slug_insert"
    /\ \/ /\ AddRow(r)
          /\ Finish(r, "admitted")
       \/ /\ WritesFail
          /\ UNCHANGED <<rows, wrote>>
          /\ Finish(r, "failed")
    /\ UNCHANGED <<orgRow, seatRow, inv, already, tries>>

-----------------------------------------------------------------------------
(* Postgres: createPostgresAdmissions.admit, tenancy/admissions.ts:185-247. *)

\* :188-190 BEGIN, then SELECT pg_advisory_xact_lock. At REPEATABLE READ the transaction's snapshot is taken when this
\* first statement starts, before it waits for the lock.
PgLockStatement(r) ==
    /\ pc[r] = "pg_lock"
    /\ snap' = IF Isolation = "repeatable read" THEN [snap EXCEPT ![r] = Committed] ELSE snap
    /\ pc' = [pc EXCEPT ![r] = "pg_wait"]
    /\ UNCHANGED <<store, lock, path, already, txn, wrote, tries>>

PgLockGranted(r) ==
    /\ pc[r] = "pg_wait"
    /\ lock = {}
    /\ lock' = {r}
    /\ pc' = [pc EXCEPT ![r] = IF ByInvitation(r) THEN "pg_read_inv" ELSE "pg_read_member"]
    /\ UNCHANGED <<store, path, snap, already, txn, wrote, tries>>

\* :192-200 SELECT the invitation; tenancy/claim.ts:414-419 refuses one that is not pending; ROLLBACK.
PgReadInvitation(r) ==
    /\ pc[r] = "pg_read_inv"
    /\ IF Seen(r).inv[Who(r)] = "pending" THEN Goto(r, "pg_read_member") ELSE Finish(r, "refused")
    /\ UNCHANGED <<store, already, wrote, tries>>

\* :201-205 SELECT the person's member row.
PgReadMember(r) ==
    /\ pc[r] = "pg_read_member"
    /\ already' = [already EXCEPT ![r] = Seen(r).rows[Who(r)] > 0]
    /\ Goto(r, IF ~already'[r] THEN "pg_read_seats" ELSE IF ByInvitation(r) THEN "pg_accept" ELSE "pg_commit")
    /\ UNCHANGED <<store, wrote, tries>>

\* :207-211 seatsIn (:142-175, one SELECT of the member count, orgs and org_open_seats) and seatRule
\* (tenancy/claim.ts:94-101). With no orgs/org_seats row, :152-153 throws orgStillBeingSetUp and :241-242 rolls back;
\* 76c1f36 returned seats undefined (76c1f36 admissions.ts:121) and seatRule let the person in (76c1f36 claim.ts:97).
PgReadSeats(r) ==
    /\ pc[r] = "pg_read_seats"
    /\ LET v == Seen(r)
           next == IF ByInvitation(r) THEN "pg_accept" ELSE "pg_insert"
       IN IF ~v.seatRow
            THEN IF NoSeatRow = "refuse" THEN Finish(r, "refused") ELSE Goto(r, next)
            ELSE IF Total(v.rows, People) >= Seats THEN Finish(r, "refused") ELSE Goto(r, next)
    /\ UNCHANGED <<store, already, wrote, tries>>

\* :212-221 UPDATE invitation SET status = 'accepted' WHERE ... AND status = 'pending'. READ COMMITTED evaluates the
\* WHERE against the newest committed row; REPEATABLE READ raises 40001 when the row changed after the snapshot, and
\* :241-242 rolls back. rowCount 0 rolls back as not_pending.
PgAccept(r) ==
    /\ pc[r] = "pg_accept"
    /\ LET i == Who(r) IN
         IF Isolation = "repeatable read" /\ inv[i] # snap[r].inv[i]
           THEN Finish(r, "failed")
           ELSE IF inv[i] = "pending"
                  THEN /\ txn' = [txn EXCEPT ![r].accept = TRUE]
                       /\ pc' = [pc EXCEPT ![r] = IF already[r] THEN "pg_commit" ELSE "pg_insert"]
                       /\ UNCHANGED <<lock, snap, path>>
                  ELSE Finish(r, "refused")
    /\ UNCHANGED <<store, already, wrote, tries>>

\* :222-230 INSERT INTO member. The session UPDATE at :231-238 changes nothing here; its failure is PgFails.
PgInsert(r) ==
    /\ pc[r] = "pg_insert"
    /\ txn' = [txn EXCEPT ![r].member = TRUE]
    /\ pc' = [pc EXCEPT ![r] = "pg_commit"]
    /\ UNCHANGED <<store, lock, path, snap, already, wrote, tries>>

\* :239 COMMIT. Its writes become visible, then the transaction-level lock goes. If the connection drops after the server
\* applied the COMMIT and before its reply reached the client, :241-243 runs: the ROLLBACK has nothing to undo, and admit()
\* rethrows. The request reports a failure with every write made, and ends "reply_lost".
PgCommit(r) ==
    /\ pc[r] = "pg_commit"
    /\ IF txn[r].member THEN AddRow(r) ELSE UNCHANGED <<rows, wrote>>
    /\ inv' = IF txn[r].accept THEN [inv EXCEPT ![Who(r)] = "accepted"] ELSE inv
    /\ \/ Finish(r, "admitted")
       \/ /\ WritesFail
          /\ Finish(r, "reply_lost")
    /\ UNCHANGED <<orgRow, seatRow, already, tries>>

\* :241-242 any statement, COMMIT included, throws before the server applied it: ROLLBACK, nothing written, the lock goes.
PgFails(r) ==
    /\ WritesFail
    /\ pc[r] \in InTransaction
    /\ Finish(r, "failed")
    /\ UNCHANGED <<store, already, wrote, tries>>

-----------------------------------------------------------------------------
(* File mode: createAdapterAdmissions.admit, tenancy/admissions.ts:291-346. *)
(* Each adapter call is one step of the in-memory Better Auth adapter.     *)

\* :292 locks.lock(claim:join:<orgId>), the in-process coordinator (store/coordination.ts:168-177).
AdLock(r) ==
    /\ pc[r] = "ad_lock"
    /\ lock = {}
    /\ lock' = {r}
    /\ pc' = [pc EXCEPT ![r] = IF ByInvitation(r) THEN "ad_read_inv" ELSE "ad_read_member"]
    /\ UNCHANGED <<store, path, snap, already, txn, wrote, tries>>

\* :295-300 readInvitation and refusalOf; anything but pending returns, and the lock goes.
AdReadInvitation(r) ==
    /\ pc[r] = "ad_read_inv"
    /\ IF inv[Who(r)] = "pending" THEN Goto(r, "ad_read_member") ELSE Finish(r, "refused")
    /\ UNCHANGED <<store, already, wrote, tries>>

\* :301-308 adapter.findOne member. A member joining again writes nothing and is admitted.
AdReadMember(r) ==
    /\ pc[r] = "ad_read_member"
    /\ already' = [already EXCEPT ![r] = rows[Who(r)] > 0]
    /\ IF ~already'[r] THEN Goto(r, "ad_read_seats")
       ELSE IF ByInvitation(r) THEN Goto(r, "ad_reread_inv")
       ELSE Finish(r, "admitted")
    /\ UNCHANGED <<store, wrote, tries>>

\* :310-315 options.seatsOf (auth/better-auth.ts:172-175: getOrg, then countMembers, both under the lock) and seatRule.
\* With no orgs row, :312 throws orgStillBeingSetUp; 76c1f36 passed seats undefined
\* (76c1f36 auth/better-auth.ts:174-176) and seatRule let the person in (76c1f36 claim.ts:97).
AdReadSeats(r) ==
    /\ pc[r] = "ad_read_seats"
    /\ LET next == IF ByInvitation(r) THEN "ad_reread_inv" ELSE "ad_insert"
       IN IF ~seatRow
            THEN IF NoSeatRow = "refuse" THEN Finish(r, "refused") ELSE Goto(r, next)
            ELSE IF Members >= Seats THEN Finish(r, "refused") ELSE Goto(r, next)
    /\ UNCHANGED <<store, already, wrote, tries>>

\* :316-321 readInvitation again, under the lock.
AdRereadInvitation(r) ==
    /\ pc[r] = "ad_reread_inv"
    /\ IF inv[Who(r)] = "pending" THEN Goto(r, "ad_accept") ELSE Finish(r, "refused")
    /\ UNCHANGED <<store, already, wrote, tries>>

\* :322-323 adapter.update invitation WHERE status = pending, to accepted; null returns not_pending. It sits before the
\* try at :325, so if it throws there is nothing to undo.
AdAccept(r) ==
    /\ pc[r] = "ad_accept"
    /\ LET i == Who(r) IN
         \/ /\ inv[i] = "pending"
            /\ inv' = [inv EXCEPT ![i] = "accepted"]
            /\ Goto(r, IF already[r] THEN "ad_session" ELSE "ad_insert")
         \/ /\ inv[i] # "pending"
            /\ Finish(r, "refused")
            /\ UNCHANGED inv
         \/ /\ WritesFail
            /\ Finish(r, "failed")
            /\ UNCHANGED inv
    /\ UNCHANGED <<orgRow, seatRow, rows, already, wrote, tries>>

\* :326-331 adapter.create member. If it throws, :339-343 runs for an invitation; a plain join has nothing to undo.
AdInsert(r) ==
    /\ pc[r] = "ad_insert"
    /\ \/ /\ AddRow(r)
          /\ IF ByInvitation(r) THEN Goto(r, "ad_session") ELSE Finish(r, "admitted")
       \/ /\ WritesFail
          /\ UNCHANGED <<rows, wrote>>
          /\ IF ByInvitation(r) THEN Goto(r, "ad_compensate") ELSE Finish(r, "failed")
    /\ UNCHANGED <<orgRow, seatRow, inv, already, tries>>

\* :332-338 adapter.update session (activeOrganizationId). If it throws, :339-343 runs.
AdSession(r) ==
    /\ pc[r] = "ad_session"
    /\ \/ Finish(r, "admitted")
       \/ /\ WritesFail
          /\ Goto(r, "ad_compensate")
    /\ UNCHANGED <<store, already, wrote, tries>>

\* :339-343 the compensation: adapter.update invitation WHERE status = accepted, back to pending. Its own failure is
\* swallowed by .catch(() => undefined), then admit() rethrows the first error.
AdCompensate(r) ==
    /\ pc[r] = "ad_compensate"
    /\ LET i == Who(r) IN
         \/ inv' = IF inv[i] = "accepted" THEN [inv EXCEPT ![i] = "pending"] ELSE inv
         \/ /\ WritesFail
            /\ UNCHANGED inv
    /\ Finish(r, "failed")
    /\ UNCHANGED <<orgRow, seatRow, rows, already, wrote, tries>>

-----------------------------------------------------------------------------
(* ffa2916: Better Auth's accept-invitation endpoint with Guard's          *)
(* beforeAcceptInvitation hook (better-auth 1.7.2,                         *)
(* dist/plugins/organization/routes/crud-invites.mjs). No org lock and no  *)
(* transaction: every statement commits on its own.                       *)

\* crud-invites.mjs:267-268 findInvitationById; not pending is INVITATION_NOT_FOUND.
HookReadInvitation(r) ==
    /\ pc[r] = "hk_read_inv"
    /\ IF inv[Who(r)] = "pending" THEN Goto(r, "hk_count") ELSE Finish(r, "refused")
    /\ UNCHANGED <<store, already, wrote, tries>>

\* crud-invites.mjs:275-283 then beforeAcceptInvitation (ffa2916 auth/better-auth.ts:363-365) calls
\* refuseIfOrgIsFull (ffa2916 tenancy/claim.ts:69-74), which counts the members.
HookCountMembers(r) ==
    /\ pc[r] = "hk_count"
    /\ IF Members >= Seats THEN Finish(r, "refused") ELSE Goto(r, "hk_accept")
    /\ UNCHANGED <<store, already, wrote, tries>>

\* crud-invites.mjs:285-290 updateInvitation from pending to accepted.
HookAccept(r) ==
    /\ pc[r] = "hk_accept"
    /\ LET i == Who(r) IN
         \/ /\ inv[i] = "pending"
            /\ inv' = [inv EXCEPT ![i] = "accepted"]
            /\ Goto(r, "hk_insert")
         \/ /\ inv[i] # "pending"
            /\ Finish(r, "refused")
            /\ UNCHANGED inv
    /\ UNCHANGED <<orgRow, seatRow, rows, already, wrote, tries>>

\* crud-invites.mjs:324-329 createMember.
HookInsert(r) ==
    /\ pc[r] = "hk_insert"
    /\ AddRow(r)
    /\ Finish(r, "admitted")
    /\ UNCHANGED <<orgRow, seatRow, inv, already, tries>>

-----------------------------------------------------------------------------
(* Outside the org lock.                                                   *)

\* console-api/people.ts:284-306 calls Better Auth cancelInvitation (crud-invites.mjs:447-450), which sets canceled
\* whatever the status. On Postgres it waits for the row lock an open admit() transaction holds after its UPDATE.
Cancel(i) ==
    /\ CreatorDone
    /\ inv[i] # "canceled"
    /\ \A r \in Requests : Who(r) = i => ~txn[r].accept
    /\ inv' = [inv EXCEPT ![i] = "canceled"]
    /\ UNCHANGED <<orgRow, seatRow, rows, lock, pc, path, snap, already, txn, wrote, tries>>

Settled ==
    /\ \A r \in Requests : pc[r] \in Terminal
    /\ UNCHANGED vars

Step(r) ==
    \/ JoinBySlug(r) \/ OpenInvitation(r) \/ SendAgain(r) \/ SlugInsert(r)
    \/ PgLockStatement(r) \/ PgLockGranted(r) \/ PgReadInvitation(r) \/ PgReadMember(r) \/ PgReadSeats(r)
    \/ PgAccept(r) \/ PgInsert(r) \/ PgCommit(r) \/ PgFails(r)
    \/ AdLock(r) \/ AdReadInvitation(r) \/ AdReadMember(r) \/ AdReadSeats(r) \/ AdRereadInvitation(r)
    \/ AdAccept(r) \/ AdInsert(r) \/ AdSession(r) \/ AdCompensate(r)
    \/ HookReadInvitation(r) \/ HookCountMembers(r) \/ HookAccept(r) \/ HookInsert(r)

Next ==
    \/ CreateInOneTransaction \/ CreateOrgRow \/ CreateTakesLock \/ CreateSeatRow \/ CreateOwnerRow
    \/ \E r \in Requests : Step(r)
    \/ \E i \in Invited : Cancel(i)
    \/ Settled

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* What the code promises.                                                 *)

\* The harm: an org holds more people than it pays for, Free's hard cap included.
SeatLimit == Members <= Seats

\* A second row for one person takes a second seat.
OneRowPerPerson == \A p \in People : rows[p] <= 1

\* Once every request for it has finished, an accepted invitation has its person in the org.
NoLostInvitation ==
    \A i \in Invited :
        (inv[i] = "accepted" /\ \A r \in Requests : Who(r) = i => pc[r] \in Terminal) => rows[i] > 0

\* A request that ends refused or failed left no member row behind. A request that ends reply_lost is not held to it: its
\* COMMIT applied every write at once, and the client cannot tell a lost reply from a failed COMMIT.
FailedAdmissionWritesNothing == \A r \in Requests : pc[r] \in {"refused", "failed"} => ~wrote[r]

\* A request that ends admitted has its person in the org.
AdmittedMeansMember == \A r \in Requests : pc[r] = "admitted" => rows[Who(r)] > 0

\* A canceled invitation never comes back to pending or accepted.
CanceledStaysCanceled == [][\A i \in Invited : inv[i] = "canceled" => inv'[i] = "canceled"]_vars

=============================================================================
