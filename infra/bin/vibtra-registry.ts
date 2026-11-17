#!/usr/bin/env tsx
import { App } from "aws-cdk-lib";
import { defineRegistryApp } from "../lib/app.js";

defineRegistryApp(new App()).synth();
