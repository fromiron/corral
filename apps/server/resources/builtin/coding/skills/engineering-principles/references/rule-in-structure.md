# Rule in structure

**Rule.** A lesson worth repeating is worth enforcing. Put it where a machine checks it.

**Why.** Prose depends on being read at the right moment. A check runs every time.

**Where to put it, strongest first**

1. In the design, so the mistake cannot be expressed: a narrower type, a single entry point, a constructor that validates.
2. In tooling that runs on every change: a lint rule, a build assertion, a pipeline step.
3. In a test that goes red when the lesson is ignored.
4. In a script that performs the task correctly and replaces the manual steps.
5. In written guidance kept beside the code it concerns, when nothing stronger fits.

**In practice**

- Choose the strongest place that is practical for this lesson.
- Note which mechanism guards which lesson. Guidance with no mechanism behind it should be expected to fail.

**It applies when** you give the same review comment again, a checklist step is routinely missed, or a comment starts with "remember to".
