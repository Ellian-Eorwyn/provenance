# Zero-downtime migration approaches

Two complementary strategies answer the question.

First, DNS cutover after staging validation: "cut over DNS only after the staging copy is fully validated" [ext-d8129f9b7114]. This is the low-infrastructure path (`ext-d8129f9b7114`, `src-b95bb22d8232`).

Second, blue-green routing: "switching is instant because it only redirects the router" [ext-77004eca0a27]. Rollback is symmetric (`ext-77004eca0a27`, `src-604878cb9e3d`).

Sources: `src-b95bb22d8232`, `src-604878cb9e3d`.
