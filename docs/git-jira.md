# Branches, commits and Jira

The issue menu (and the keys on an issue or a selected row) copies:

| Key | Copies | Example |
| --- | --- | --- |
| `c` | the issue key | `MAGA-399` |
| `b` | a branch name | `feature/MAGA-399-creazione-inventario-da-app-magazziniere` |
| `m` | a commit message | `MAGA-399 Creazione inventario da app magazziniere` |

## Branch names

- The prefix is `bugfix/` for a bug (the issue type `Bug`, or its Italian names
  such as `Errore` or `Difetto`), `feature/` for anything else.
- The key keeps the tracker's case: Jira matches keys in upper case only.
- The slug takes the summary's first six words, accents folded, and is cut at a
  whole word so the name stays within 60 characters.
- The slug never ends on a lone letter or a linking word (`da`, `per`,
  `the`, `of`…), which would read as a name cut halfway.

## How Jira links commits

Jira shows commits, branches and pull requests on an issue (the Development
panel) only when two things are true:

1. **The repository is connected to Jira.** On Jira Server or Data Center that
   is a DVCS link (Bitbucket, GitLab or GitHub, set up by a Jira admin). Without
   it no branch or commit name shows anything, whatever it contains.
2. **The issue key is in the text Jira reads.**
   - A branch is linked when its name contains the key (`feature/MAGA-399-…`).
   - A commit is linked only when its **message** contains the key. A commit on
     a well-named branch whose message lacks the key is not linked.
   - Keys must be upper case (`MAGA-399`, not `maga-399`).

So copy the commit message with `m`, or let git add the key for you.

## A hook that adds the key to every commit

Save this as `.git/hooks/prepare-commit-msg` in the repository and make it
executable (`chmod +x .git/hooks/prepare-commit-msg`). It takes the key from the
branch name and puts it in front of the message, unless the message already
has it. Merges, amends and squashes are left alone.

```sh
#!/bin/sh
# Prepend the Jira key found in the branch name (e.g. feature/MAGA-399-…).
file="$1"
source="$2"
case "$source" in merge|squash|commit) exit 0 ;; esac
branch=$(git symbolic-ref --short HEAD 2>/dev/null) || exit 0
key=$(printf '%s' "$branch" | grep -oE '[A-Z][A-Z0-9]+-[0-9]+' | head -n 1)
[ -n "$key" ] || exit 0
grep -qE "(^|[^A-Z0-9])$key([^0-9]|$)" "$file" && exit 0
tmp=$(mktemp) || exit 0
{ printf '%s ' "$key"; cat "$file"; } > "$tmp" && mv "$tmp" "$file"
```

To use it in every repository, put it in a template directory and point git at
it once: `git config --global init.templateDir ~/.git-template` (then copy the
file to `~/.git-template/hooks/`); existing clones pick it up with `git init`.
