# How to migrate a WordPress site with no downtime

Migrating a live WordPress site is mostly about sequencing. Build the new environment on a staging host, then cut over DNS only after the staging copy is fully validated, so no visitor ever hits a broken page.

During DNS propagation, both hosts should serve identical content, so nobody sees downtime.
