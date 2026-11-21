# Guards at the edges

**Rule.** Validate at the points where data comes in from outside. Past those points, rely on what validation established.

**In practice**

- Outside means anything the program does not control: arguments, settings files, requests, uploads, replies from other services, text produced by a model, a path typed by a person.
- At each entry point, turn raw input into a checked value with a definite type. Reject what does not fit, with a message that names the problem.
- Deal with the outside world's failures (slow, absent, malformed) in the same place.
- Keep the decision-making code free of input and output, so it can be tested with plain values.
- Inside, do not check again. A defensive test for something the types already exclude can only hide a mistake made upstream.

**You skipped it when** every layer of a call chain tests the same argument for null, parsing and business rules share a function, or a private function validates what its one caller just validated.
