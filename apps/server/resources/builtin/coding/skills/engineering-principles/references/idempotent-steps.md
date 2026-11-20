# Idempotent steps

**Rule.** Running a step a second time, or picking it up after it was cut short, leaves things exactly as one clean run would.

**In practice**

- Describe the step by the state it should leave behind. Then write it to reach that state from wherever things currently stand.
- Give each operation an identity. A repeat can then be recognised and answered with the first result.
- Look before acting: create what is absent, update what differs, leave alone what is already right.
- Keep the unit of work small, and record progress after each unit, so an interruption costs one unit.
- When a reply is lost, find out what became of the request. Do not send it again under a new identity.

**You skipped it when** a retry creates a duplicate, a script fails on its second run because something already exists, or the recovery notes begin with cleaning up by hand.

**Outside effects.** A sent message, a payment or a deployment may be impossible to repeat safely or to undo. Name such effects and guard each one separately.
