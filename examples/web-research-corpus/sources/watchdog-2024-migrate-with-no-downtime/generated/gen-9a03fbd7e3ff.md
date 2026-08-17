# Summary

The article recommends sequencing the migration so downtime never occurs: "cut over DNS only after the staging copy is fully validated" [ext-d8129f9b7114]. During DNS propagation both hosts serve identical content, so nobody sees downtime.
