'use strict';

// Test runs start the real CLI; never let them send telemetry, whatever the developer's own choice is.
process.env.SPECSHIELD_TELEMETRY = '0';
