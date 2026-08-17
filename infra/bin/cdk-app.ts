/**
 * What `cdk.json` runs. It exists so `src/app.ts` can be imported by a test
 * without synthesizing a real assembly as a side effect of the import.
 */

import { App } from "aws-cdk-lib";
import { defineApp } from "../src/app.ts";

defineApp(new App()).synth();
