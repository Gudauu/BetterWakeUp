import { describe, expect, it } from "vitest";
import { GET_PARAMETERS_BATCH_SIZE, parameterStoreSource } from "../src/config/parameter-store.ts";
import {
  assertNoSecretsInEnvironment,
  cachedSecretLoader,
  environmentSecretLeaks,
  loadSecrets,
  MissingSecretsError,
  SECRET_NAMES,
  SECRET_PARAMETER_SEGMENTS,
  SECRET_PREFIX_VARIABLE,
  type SecretSource,
  secretParameterName,
  secretParameterNames,
  secretParameterPrefix,
} from "../src/config/secrets.ts";

const prefix = secretParameterPrefix("dev");

function sourceWith(values: Partial<Record<string, string>>): SecretSource {
  return {
    async read(names) {
      const resolved: Record<string, string> = {};
      for (const name of names) {
        const value = values[name];
        if (typeof value === "string") {
          resolved[name] = value;
        }
      }
      return resolved;
    },
  };
}

function everySecret(): Record<string, string> {
  return Object.fromEntries(
    SECRET_NAMES.map((name) => [secretParameterName(prefix, name), `value-of-${name}`]),
  );
}

describe("the secret set", () => {
  it("is closed, and every name has a parameter segment", () => {
    expect(SECRET_NAMES.length).toBeGreaterThan(0);
    for (const name of SECRET_NAMES) {
      expect(SECRET_PARAMETER_SEGMENTS[name]).toMatch(/^[a-z0-9-]+$/);
    }
    // No two secrets may share a path, or one would silently read the other.
    const segments = SECRET_NAMES.map((name) => SECRET_PARAMETER_SEGMENTS[name]);
    expect(new Set(segments).size).toBe(segments.length);
  });

  it("holds only credentials, not the client identifiers the app publishes", () => {
    expect(SECRET_NAMES).not.toContain("appleClientId");
    expect(SECRET_NAMES).not.toContain("googleClientId");
  });

  it("separates one stage's parameters from another's", () => {
    expect(secretParameterPrefix("dev")).not.toBe(secretParameterPrefix("prod"));
    for (const name of secretParameterNames(secretParameterPrefix("prod"))) {
      expect(name.startsWith("/betterwakeup/prod/")).toBe(true);
    }
  });

  it("tolerates a prefix given with a trailing slash", () => {
    expect(secretParameterName(`${prefix}/`, "databaseUrl")).toBe(
      secretParameterName(prefix, "databaseUrl"),
    );
  });
});

describe("loading secrets", () => {
  it("asks for every parameter in one call", async () => {
    const asked: string[][] = [];
    const source: SecretSource = {
      async read(names) {
        asked.push([...names]);
        return everySecret();
      },
    };
    await loadSecrets(source, prefix);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual(secretParameterNames(prefix));
  });

  it("resolves every secret by its own name", async () => {
    const secrets = await loadSecrets(sourceWith(everySecret()), prefix);
    for (const name of SECRET_NAMES) {
      expect(secrets[name]).toBe(`value-of-${name}`);
    }
  });

  it("reports every missing parameter at once, rather than the first", async () => {
    const values = everySecret();
    delete values[secretParameterName(prefix, "databaseUrl")];
    delete values[secretParameterName(prefix, "paymentWebhookSecret")];

    const error = await loadSecrets(sourceWith(values), prefix).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MissingSecretsError);
    expect((error as MissingSecretsError).missing).toEqual(["databaseUrl", "paymentWebhookSecret"]);
  });

  it("treats an empty parameter as missing, because a blank key is not a key", async () => {
    const values = { ...everySecret(), [secretParameterName(prefix, "sessionSigningKey")]: "" };
    await expect(loadSecrets(sourceWith(values), prefix)).rejects.toThrow(MissingSecretsError);
  });

  it("names parameters and never values in its message", async () => {
    const values = everySecret();
    delete values[secretParameterName(prefix, "databaseUrl")];
    values[secretParameterName(prefix, "sessionSigningKey")] = "a-real-signing-key";

    const error = await loadSecrets(sourceWith(values), prefix).catch((caught: unknown) => caught);
    expect(String(error)).toContain("database-url");
    expect(String(error)).not.toContain("a-real-signing-key");
  });
});

describe("the cached loader", () => {
  it("reads once per container, however many callers ask", async () => {
    let reads = 0;
    const load = cachedSecretLoader(
      {
        async read(names) {
          reads += 1;
          return sourceWith(everySecret()).read(names);
        },
      },
      prefix,
    );

    const [first, second] = await Promise.all([load(), load()]);
    await load();
    expect(reads).toBe(1);
    expect(first).toBe(second);
  });

  it("does not cache a failure, so a transient outage is not permanent", async () => {
    let attempt = 0;
    const load = cachedSecretLoader(
      {
        async read(names) {
          attempt += 1;
          if (attempt === 1) {
            throw new Error("Parameter Store is unreachable.");
          }
          return sourceWith(everySecret()).read(names);
        },
      },
      prefix,
    );

    await expect(load()).rejects.toThrow("unreachable");
    const secrets = await load();
    expect(secrets.databaseUrl).toBe("value-of-databaseUrl");
    expect(attempt).toBe(2);
  });
});

describe("the refusal to read secrets from the environment", () => {
  it("accepts the variables the stack actually sets", () => {
    expect(
      environmentSecretLeaks({
        STAGE: "dev",
        NODE_OPTIONS: "--enable-source-maps",
        [SECRET_PREFIX_VARIABLE]: prefix,
      }),
    ).toEqual([]);
  });

  it("catches a secret named as one, whatever its value", () => {
    const leaks = environmentSecretLeaks({ DATABASE_URL: "unset", SESSION_SIGNING_KEY: "x" });
    expect(leaks.map((leak) => leak.variable).sort()).toEqual([
      "DATABASE_URL",
      "SESSION_SIGNING_KEY",
    ]);
    expect(leaks.every((leak) => leak.reason === "name")).toBe(true);
  });

  it("catches a secret hidden behind an innocent name, by its value", () => {
    const leaks = environmentSecretLeaks({
      NEON: `postgres${"ql"}://bwu:hunter2@ep-example.aws.neon.tech/main`,
    });
    expect(leaks).toEqual([{ variable: "NEON", reason: "value" }]);
  });

  it("leaves the runtime's own credentials alone, because they are not ours", () => {
    // Refusing to start because AWS supplied the execution role's credentials
    // would make the check unusable, which is how checks get deleted.
    expect(
      environmentSecretLeaks({
        AWS_SECRET_ACCESS_KEY: "supplied-by-lambda",
        AWS_SESSION_TOKEN: "supplied-by-lambda",
        LAMBDA_TASK_ROOT: "/var/task",
      }),
    ).toEqual([]);
  });

  it("refuses to start, naming the variable and not its value", () => {
    // Assembled rather than written out, because the repository scan in the
    // infrastructure tests reads this file too and a literal here is
    // indistinguishable from a real leak. Split inside the prefix, which is
    // the part the pattern matches on.
    const webhookSecret = `whsec${"_live_"}abcdefgh12345678`;
    expect(() => assertNoSecretsInEnvironment({ PAYMENT_WEBHOOK_SECRET: webhookSecret })).toThrow(
      /PAYMENT_WEBHOOK_SECRET/,
    );
    expect(() =>
      assertNoSecretsInEnvironment({ PAYMENT_WEBHOOK_SECRET: webhookSecret }),
    ).not.toThrow(/abcdefgh12345678/);
  });

  it("passes on this process's own environment", () => {
    expect(() => assertNoSecretsInEnvironment()).not.toThrow();
  });
});

describe("the Parameter Store source", () => {
  it("asks for decryption, which is what makes a SecureString readable", async () => {
    const sent: { Names?: string[]; WithDecryption?: boolean }[] = [];
    const source = parameterStoreSource({
      client: {
        async send(command) {
          sent.push(command.input as { Names?: string[]; WithDecryption?: boolean });
          return { Parameters: [{ Name: "/a", Value: "one" }] };
        },
      },
    });

    expect(await source.read(["/a"])).toEqual({ "/a": "one" });
    expect(sent[0]?.WithDecryption).toBe(true);
    expect(sent[0]?.Names).toEqual(["/a"]);
  });

  it("omits a parameter the service did not return, rather than inventing one", async () => {
    const source = parameterStoreSource({
      client: {
        async send() {
          return { Parameters: [{ Name: "/a", Value: "one" }] };
        },
      },
    });
    expect(await source.read(["/a", "/b"])).toEqual({ "/a": "one" });
  });

  it("batches past the service's per-call limit", async () => {
    const batches: number[] = [];
    const names = Array.from({ length: GET_PARAMETERS_BATCH_SIZE + 3 }, (_, i) => `/p${i}`);
    const source = parameterStoreSource({
      client: {
        async send(command) {
          const asked = (command.input as { Names: string[] }).Names;
          batches.push(asked.length);
          return { Parameters: asked.map((name) => ({ Name: name, Value: "v" })) };
        },
      },
    });

    const resolved = await source.read(names);
    expect(batches).toEqual([GET_PARAMETERS_BATCH_SIZE, 3]);
    expect(Object.keys(resolved)).toHaveLength(names.length);
  });
});
