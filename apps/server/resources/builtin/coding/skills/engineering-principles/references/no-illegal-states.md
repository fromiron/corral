# No illegal states

**Rule.** Arrange types so that a value that must not exist cannot be constructed.

**Why.** A rule kept by the type system is checked on every build. A rule kept by convention is checked when someone remembers.

**In practice**

- When fields only make sense together, group them. A shipped order carries a tracking number. A pending order does not have the field at all.
- When two values of the same primitive type must not be confused (a user id and an order id, metres and feet), declare a separate type for each.
- Where code branches on a kind, make the compiler demand every kind, so a new one cannot be forgotten.
- Keep a single definition of each structure and generate the others from it.
- Build these values in one place, at the point where data enters.

**You skipped it when** a comment says a combination cannot happen, a function takes several booleans, or fields are documented as "only present if".

**Without static types** the same idea lives in constructors and schemas. One function creates the value, and it refuses a bad one.
