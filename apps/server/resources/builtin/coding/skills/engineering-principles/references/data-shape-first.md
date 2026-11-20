# Data shape first

**Rule.** Settle what the data looks like before writing the code that acts on it.

**Why.** Logic is downstream of data. With a fitting shape, most functions are a few obvious lines. With a poor one, each function carries its own patch for the mismatch.

**In practice**

- List the things the feature deals with and the fields of each. For anything with a lifecycle, list its stages and which moves between stages are allowed.
- Pick a container by how the data is read: looked up by key, walked in order, taken one at a time, searched by several fields.
- Where the code would ask "which kind is this?" in many places, give the kinds one shared structure and ask once.
- Note which parts two workers may touch at the same time. That belongs to the shape; it is not a detail for later.
- If the feature needs groundwork (a table, a type, a registry), lay it before the feature.

**You skipped it when** adding a case means editing a conditional in four files, two fields must be updated together and nothing makes that happen, or different functions disagree about whether a list can be empty.

**Leave it alone when** the code is short, used in one place and not expected to grow. A new layer that removes no condition and prevents no invalid value is cost without benefit.
