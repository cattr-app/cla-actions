import { getInput } from "./runtime";

export interface Config {
    operation: string;
    botToken: string;
    botAppSlug: string;
    registryToken: string;
    sourceToken: string;
    registryRepository: string;
    claPath: string;
    exemptLogins: Set<string>;
}

export function loadConfig(): Config {
    const exempt = (
        process.env.CLA_EXEMPT_LOGINS?.trim() ||
        "dependabot[bot]"
    )
        .split(/\r?\n/)
        .map(value => value.trim())
        .filter(Boolean);

    return {
        operation: getInput("operation", true),
        botToken: getInput("bot-token"),
        botAppSlug: getInput("bot-app-slug"),
        registryToken: getInput("registry-token"),
        sourceToken: getInput("source-token"),
        registryRepository: getInput(
            "registry-repository",
            false,
            "cattr-app/cla-registry",
        ),
        claPath: getInput("cla-path", false, "CLA.md"),
        exemptLogins: new Set(exempt),
    };
}
