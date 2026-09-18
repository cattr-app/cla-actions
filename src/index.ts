import { loadConfig } from "./config";
import { error } from "./runtime";
import { runCheck } from "./operations/check";
import { runSign } from "./operations/sign";
import { runClaim } from "./operations/claim";
import { runSync } from "./operations/sync";

async function main(): Promise<void> {
    const config = loadConfig();

    switch (config.operation) {
        case "check":
            await runCheck(config);
            return;

        case "sign":
            await runSign(config);
            return;

        case "claim":
            await runClaim(config);
            return;

        case "sync":
            await runSync(config);
            return;

        default:
            throw new Error(`Unknown CLA operation: ${config.operation}`);
    }
}

main().catch((reason: unknown) => {
    const message =
        reason instanceof Error
            ? reason.stack ?? reason.message
            : String(reason);

    error(message);
    process.exitCode = 1;
});
