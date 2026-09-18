declare const process: {
    env: Record<string, string | undefined>;
    exitCode?: number;
};

declare const Buffer: {
    from(input: string, encoding?: string): {
        toString(encoding?: string): string;
    };
};

declare function require(name: string): any;

declare function fetch(
    input: string,
    init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
    },
): Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
    json(): Promise<any>;
    headers: {
        get(name: string): string | null;
    };
}>;
