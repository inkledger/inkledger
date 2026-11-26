# Who pays for what (Chi paga cosa)

How add-on modules reach people on an inkledger server, who pays for each licence, and who manages it. The server enforces all of it (`api/routers/store.ts`, `api/store/seats.ts`). Every step below is recorded in the audit log.

## The rule: one licence, one person

- A licence is always one named person's. One purchase or approved request gives one licence, and that licence belongs to one holder.
- A team never shares a licence. Assigning a module to a team buys one licence for each chosen member, and the dialog shows how many ("N licences") before anything is bought.
- Moving a licence (reassigning it) changes its holder. It is never copied, and the old holder loses the module. Their saved progress is kept for when it comes back.
- The ledger (`module_licences`) records each licence's holder, who pays (the holder, an admin, or a team) and who bought it.

## The three ways in

| | Who decides | Who pays | Who manages the licence | What the person does |
| --- | --- | --- | --- | --- |
| **Offer** (to a person or a team) | A Store manager (`manageStore`) | The person, for themselves | The person: it is theirs, and they can download it | Sees it in their Store, requests or buys it, then switches it and sets it up |
| **Assign** (to a person or a team) | A Store manager | The admin, or the team (one licence per member) | The buyer side (Settings → Store, the module's sheet → "Who gets it") | Switches it and sets it up, nothing more |
| **Whole catalogue** (`acquireModules`) | An admin gives the permission | The person, for themselves | The person | Browses everything and buys or requests for themselves |

- A team offer reaches the team's members as the team is when they look. Someone who joins later sees it. Someone outside the team never does.
- A person without offers, assigned modules or `acquireModules` sees no module in the Store.
- Members have none of these by default. Owners and IT admins hold `acquireModules` through `manageStore`, which implies it. `acquireModules` in turn implies `useModules`, because whoever buys a module must be able to run it.

## Purchases inside a module

Packs, emotes and anything else bought inside a module are always the person's own. Anyone with the module granted can buy them for themselves. An admin never buys them for someone else.

The host has no in-module purchase API yet. When one arrives, it must follow this rule: the buyer is the signed-in person, and there is no "buy for others".

## Details and defaults

- **Assign and addresses.** Each licence request needs an email address, and the Store refuses a second request from the same address for the same module. The assign dialog fills in each person's account address when it is an email, and the admin sees and can edit every address before confirming. Nothing is sent without that confirmation.
- **Paid assignments.** A paid assignment opens one checkout per person, so N payments for N licences. Each checkout's code is claimed in its person's row under "Who gets it". Running an assignment again skips anyone who already holds a licence or is waiting for one, so nobody is charged twice.
- **Reassigning.** A Store manager can move a licence the admin or a team paid for. A licence its holder bought for themselves is theirs, and it can't be moved.
- **Settings → Users.** Giving a module to someone there takes a free licence of it, one that nobody holds. Without a free licence the change is refused. Taking the module away frees that licence. Grants made before the ledger existed stay as they were.
- **Erased or removed accounts.** When a holder is erased, their licence is freed rather than lost, and a Store manager can reassign it.
- **Removing a licence.** Removing a licence from the server takes the module away from its holder.
- **Owners.** An owner runs every module without taking a licence.
- **Licence tools are per server.** Activation, servers and the licence file are a Store manager's, and they still act on the module's first licence.

## Audit events

- `store.offer` and `store.withdrawOffer`: a module offered to someone, or the offer taken back.
- `store.assign`: licences bought for people, with how many were started and how many skipped.
- `store.reassign`: a licence moved to another person.
- `store.grantAcquired`: a licence given to its person, with who paid.
- `modules.setEnabled`: a module switched on or off.
- `modules.configure`: a module's settings changed (at most one event per module and setting a minute).
- `store.requestLicense`, `store.checkout` and `store.claimPaid`: requesting, buying and claiming a module.
