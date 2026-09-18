const fs = require("fs");

export function getInput(name: string, required = false, fallback = ""): string {
    const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
    const value = process.env[key]?.trim() ?? fallback;

    if (required && value === "") {
        throw new Error(`Required action input is missing: ${name}`);
    }

    return value;
}

export function requiredEnv(name: string): string {
    const value = process.env[name];

    if (!value) {
        throw new Error(`Required environment variable is missing: ${name}`);
    }

    return value;
}

export function readEvent<T>(): T {
    const path = requiredEnv("GITHUB_EVENT_PATH");
    return JSON.parse(fs.readFileSync(path, "utf8")) as T;
}

export function repository(): string {
    return requiredEnv("GITHUB_REPOSITORY");
}

export function workflowRunId(): number {
    return Number(requiredEnv("GITHUB_RUN_ID"));
}

export function workflowRunAttempt(): number {
    return Number(requiredEnv("GITHUB_RUN_ATTEMPT"));
}

export function error(message: string): void {
    console.error(`::error::${message}`);
}

export function info(message: string): void {
    console.log(message);
}

export function shortSha(sha: string, length = 12): string {
    return sha.slice(0, length);
}
