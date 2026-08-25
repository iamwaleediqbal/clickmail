# clickmail

A mail client that exists to be operated by something that is not a person.

![CI](https://github.com/iamwaleediqbal/clickmail/actions/workflows/ci.yml/badge.svg)

Fifty-two messages across seven folders, with search, labels, spam and a
composer. It is a public web page: open it and use it, which is most of what
makes a score about it mean anything.

**Live:** [clickmail-sigma.vercel.app/gym](https://clickmail-sigma.vercel.app/gym)

**It contains no grader, no tasks, no runs, no models and no keys.** Those
belong to the harness — [agentscore](https://github.com/iamwaleediqbal/agentscore)
— which drives this page from outside with a real browser. An environment that
contains its own grader can only ever score itself.

## The contract

The whole interface a harness gets, published on `window.clickmail`:

```ts
reset()      // discard everything, and report the world it starts in
state()      // report the world as it stands
controls()   // report every control currently rendered
version      // 1, so a harness can refuse a shape it does not understand
```

No storage key, no DOM, no framework. The harness fetches the world before the
task, lets the agent act however it acts, fetches it again when the agent stops,
and grades one snapshot against the other.

It is deliberately **read-and-reset only**. There is no way to install an
arbitrary state from outside, because a driver that could write the world could
also write the answer, and a harness that can write the answer is not measuring
anything.

`controls()` exists because the check it replaced could not survive the split —
a test that read the harness's source to confirm the action space matched these
buttons. Asking the running application is better anyway: it answers for the
build that is deployed rather than the source somebody read. The harness
preflights it before every run and refuses to start if a control it expects to
be able to reach is not on the page.

## The world is one value

The whole observable world of this app is **one JSON object**, held in local
storage under `clickmail.mail.v1`. That is not a shortcut, it is the property
everything downstream depends on: if the world is one value, then "did the agent
do the task" is a comparison between two values rather than an argument about
what the screen looked like.

```
selectedId   which message is open
composer     the draft being written, or null
folder       which folder is showing
query        what is in the search box
emails[]     id, from, to, subject, body, receivedAt,
             folder, read, starred, labels[]
```

The seeded world is fixed, so a run is repeatable:

| | |
|---|---|
| messages | 52 |
| folders | inbox 18, drafts 4, outbox 2, sent 6, spam 9, archive 8, trash 5 |
| unread | 18 |
| starred | 3 |
| labels already in use | `speaking`, `admin` |

`reset()` restores exactly that, so consecutive runs start from the same place
and one agent cannot inherit another's mess.

## What a driver can touch

Every control carries a `data-testid`, which is both what `controls()` reports
and what a tool-calling agent's action names are checked against:

```
mail-list          search              search-clear        compose
folder-inbox       folder-drafts       folder-outbox       folder-sent
folder-spam        folder-archive      folder-trash
reader-star        reader-unread       reader-archive      reader-trash
reader-spam        reader-not-spam     reader-restore      reader-delete-forever
reader-reply       reader-label        reader-label-add
composer-to        composer-subject    composer-body
composer-send      composer-save       composer-discard
```

`composer-save` files the open draft in the drafts folder and closes the
composer, which is worth stating because for a while it did not: it rewrote the
open composer and left it open, so clicking Save appeared to do nothing and
Discard threw the work away. A draft is ordinary mail in the `drafts` folder,
which is also what makes it gradeable — the composer itself is gone the moment
it closes, and a verdict is computed from the final snapshot.

`search-clear` is there for a reason worth recording: typing into the search box
appends, and Backspace deletes one character, so an agent that wanted to run a
second search had to spend about seven turns undoing the first one. A turn spent
clearing a text field is not a measurement of anything.

## Two pages

| | |
|---|---|
| `/` | what this is, for a person who arrived from a link |
| `/gym` | the mailbox, and the page that publishes the contract |

The contract is installed by `/gym` and nowhere else, so a harness pointed at
the bare origin would find no `window.clickmail` at all. Rather than fail
mysteriously, the harness normalises a bare origin to `/gym` before it starts.

## Setup

Node 22 or newer. No key, no account, no service.

```bash
git clone git@github.com-personal:iamwaleediqbal/clickmail.git
cd clickmail
npm install
npm test                       # 28 tests
npm run dev                    # http://localhost:3000
```

`npm test` works before `npm install` finishes and even without it. The
environment has no test dependencies at all — Node's own runner and type
stripping — which is also why CI runs the tests before the install step rather
than after it.

### Deploy

On [vercel.com](https://vercel.com): **Add New → Project**, import `clickmail`,
deploy. There is nothing to configure.

**There are no environment variables.** Not "none required" — none read. There
is not one `process.env` reference in the repository, which is why there is no
`.env.example` either. That is the deployment posture the whole project is built
around: the gym cannot reach a model because it has no way to hold a credential,
and there is no API route on it for anything to call. A guarantee made of an
absent capability is stronger than one made of a permission check, because there
is no code path to get wrong.

### Checks

```bash
npm test           # 28 tests, no dependencies
npm run typecheck
npm run lint
python3 tools/mail-mutation-check.py
```

The last one reintroduces ten bugs this suite is supposed to catch, one at a
time, and fails if the suite stays green:

- the folder rail is written out by hand instead of derived
- the reducer performs a forward the interface has no control for
- the reducer marks read without a control, which no person can do
- the contract stops announcing what is rendered
- the search box loses its clear control, so a second search costs seven turns
- Save draft goes back to only rewriting the open composer
- a saved draft is filed somewhere other than drafts
- saving a draft leaves the composer open, so the next action refiles it
- a restored mailbox stops having its missing fields filled in
- a corrupt folder in storage is trusted instead of reset

A passing suite proves nothing if it could not go red. Two of those — the
reducer taking an action with no control behind it, and the contract quietly
under-reporting what is on the page — are the ones that matter most here,
because both would let an agent be scored on something a person could not have
done.

CI runs the same list on every push.

## What is deliberately not here

No API routes. No `runner/`, no Playwright, no Chromium. No model client, no
task list, no rubric, no run records, no leaderboard, no screenshots. No sign-in
and nothing to sign in to.

All of that is [agentscore](https://github.com/iamwaleediqbal/agentscore),
which reaches this page over HTTP the way any other visitor would — no
privileged access, no shared process, no import across the boundary. If it could
not drive this app that way, the separation would be decorative.

## License

MIT.
