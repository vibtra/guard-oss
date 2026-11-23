# Journey 12: Set each person's protection mode

- **Persona:** [IT admin](../personas.md#it-admin)
- **Trigger:** a rollout moves team by team (Finance first, then everyone), a person needs Guard off for a while, or
  blocking must stop at once.
- **Decision:** [ADR 0006](../../decisions/0006-per-person-protection-modes.md). Free in every edition. Groups are only
  a way to pick people; a group has no mode of its own.
- **How-to:** [guide/rules.md](../../guide/rules.md#1-choose-off-monitor-or-enforce).

Each person is **Off**, **Monitor** or **Enforce**. A person either follows the organisation **default** or has a
mode set for them. Off means Guard does not inspect their AI traffic and records nothing; their Mac keeps checking
in, so IT still sees it.

## Happy path

1. **Open People, Protection.** The tab shows **Default: Monitor** with how many people follow it, and **Change
   default**. Below it, the mode tabs **All**, **Enforce**, **Monitor** and **Off** each carry a count and filter the
   table. The table shows each person's **Mode**, **Set by** (who set it and when, or "Follows the default"),
   **Groups** and **Macs**. The filter adds **Set by** and **Group**. Mode and Set by are in the address, so a link
   such as `/people?tab=protection&mode=enforce&source=set` opens the filtered list.
2. **Pick people.** Tick rows, tick the header to pick everyone shown, or **Select a group**, **Finance**. Picking a
   group adds its members as people, before anything is previewed. A member who has not joined yet is not added,
   and a toast says how many.
3. **Set to…** **Enforce**, **Monitor**, **Off** or **Back to the default**. A row's ⋮ menu does the same for one
   person.
4. **Read the preview.** The dialog is titled for the change ("Set 14 people to Enforce?"). Under the server's
   summary it groups people by what happens to them, for example "Matches will now be blocked" with Monitor →
   Enforce and their names. People whose mode does not change are listed last. When anyone ends up in Monitor, it
   states the Uninspectable TLS setting ("For people in Monitor, connections Guard cannot inspect are blocked
   (Uninspectable TLS: Block)."). When people start blocking, it asks for the staff notice to have gone out; with
   Uninspectable TLS on Block, that includes people going from Off to Monitor. Nothing is written yet.
5. **Confirm.** **Set to Enforce** sends exactly the people that were previewed, the preview's revision and its
   people digest. The server writes one `guard.protection.changed` audit line per person and bumps the revision.
   The confirm for turning Guard off is marked in red. More than 1,000 people picked turns **Set to…** off and says
   to narrow the selection.
6. **Watch the rollout.** A **Rollout** panel opens above the table and stays in the address (`rollout=<revision>`),
   titled for the change ("Rollout · 14 people set to Enforce"). It counts only the people whose mode this change
   moved: "9 of 14 Macs now blocking", a bar, and "5 pending, last seen 2–40 min ago". **Show the pending Macs** lists each
   pending Mac with its person and last check-in. People with no Mac yet are counted apart, and so is an older Mac
   that cannot turn off ("1 older Mac can’t turn off: it keeps inspecting until Guard is updated on it."). It checks every 2 seconds
   for a minute, then every 10 seconds, and stops after 10 minutes with **Check again**. When every Mac has it the
   panel says **Every Mac has it**.

## Changing the default

- **People, Protection, Change default**, or **Settings, Protection, Mode**. Both open **Default mode** with Off,
  Monitor and Enforce. **Preview** shows the effect on everyone who follows the default, and says how many people set
  on their own keep their mode ("2 people set to Enforce on their own keep blocking.") with **Show them**.
- **Emergency.** When the default is Enforce, **Settings, Danger zone** has **Stop blocking for people on the
  default**. It previews only the default change to Monitor. It does not touch people set to Enforce: the preview
  says how many keep blocking and links to them, so IT can move them on purpose.

## What the rest of the dashboard shows

- **Overview** has "Protection for N people": a bar and the count in each mode, each a link to the filtered list.
  Off reads "Off · not in scope". The "Monitoring only" banner is hidden once anyone is in Enforce.
- **People** shows a person in Off at the funnel stage **Not in scope**. They are never chased.

## Branches

- **Someone changed protection after the preview.** Apply answers 409 and nothing changes. The dialog previews again
  and says so; IT confirms the new preview.
- **A picked person left the organisation.** The server answers 422 and nothing changes. The dialog names who left
  and offers **Preview without them**.
- **Nothing to change.** When everyone is already as asked, the confirm is off and the dialog says so. A retry of a
  change that already holds answers "Nothing changed". A default change that moves nobody says "The default is now
  Enforce." and opens no rollout.
- **The reply to Confirm is lost.** The dialog reads the protection page again. If the change now holds, it says it
  was saved and opens the rollout. Otherwise it says it is not known whether the change was saved and offers **Check
  again**. It never says "Nothing changed" when it cannot know.
- **An older Mac.** A Mac whose agent cannot turn inspection off yet keeps inspecting until Guard is updated on it.
  The preview's effect line says so for that person, and the rollout counts that Mac apart, not as pending.

## Gaps and open questions

- **No notification to the employee.** Settled in ADR 0006: the Mac's panel shows the current mode, and nobody is
  told.
- **The server's rollout lists everyone stamped at or after the revision.** After a clear or a default change that
  is everyone on the default, including people whose mode did not move. The console keeps the people the preview
  said would move and shows only them, but only in the tab that made the change. Opened from a link or after a
  reload, the panel shows the server's whole list and says it can include people the change did not move
  (`protectionRollout` in `apps/registry/src/guard/service.ts`).
- **The console learns which Macs cannot turn off from the preview's effect text**, per person, because neither the
  rollout nor the devices list says which Macs lack the capability. A person with one older and one updated Mac has
  both counted as older until they switch.
- **The rollout stops checking after 10 minutes.** Asleep or offline Macs catch up when they wake; **Check again**
  reads the latest state (`apps/guard-console/src/protection/RolloutPanel.tsx`).
- **Group selection is a shortcut, not a rule.** Someone who joins Finance later follows the default, not Finance's
  last change. Group policies are the paid feature.
