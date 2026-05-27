<?php

declare(strict_types=1);

namespace ClearlyIP\MagoLsp\Internal;

use PharData;
use RuntimeException;
use ZipArchive;

use function array_map;
use function array_shift;
use function bin2hex;
use function chmod;
use function escapeshellarg;
use function extension_loaded;
use function fclose;
use function file_exists;
use function file_get_contents;
use function file_put_contents;
use function flock;
use function fopen;
use function fprintf;
use function fwrite;
use function getenv;
use function implode;
use function ini_get;
use function is_dir;
use function is_file;
use function is_resource;
use function is_string;
use function ltrim;
use function mkdir;
use function number_format;
use function php_uname;
use function proc_close;
use function proc_get_status;
use function proc_open;
use function random_bytes;
use function rename;
use function rmdir;
use function str_contains;
use function strtolower;
use function sys_get_temp_dir;
use function trim;
use function unlink;
use function usleep;

use const CURLINFO_HTTP_CODE;
use const CURLOPT_FILE;
use const CURLOPT_FOLLOWLOCATION;
use const CURLOPT_HTTPHEADER;
use const CURLOPT_NOPROGRESS;
use const CURLOPT_PROGRESSFUNCTION;
use const CURLOPT_USERAGENT;
use const DIRECTORY_SEPARATOR;
use const LOCK_EX;
use const LOCK_UN;
use const PHP_OS_FAMILY;
use const STDERR;

const BIN_NAME = 'mago-lsp';
const GITHUB_REPO = 'clearlyip/mago-vscode-extension';
const STATUS_CHECK_INTERVAL = 10_000;

/** The binary version to download. Decoupled from the Composer package version so that
 *  point releases of the package do not require new binary artifacts on GitHub. */
const BINARY_VERSION = '1.29.0';

/**
 * Resolves the binary version to download.
 *
 * Override at runtime by setting the MAGO_LSP_BINARY_VERSION environment variable.
 */
function get_version(): string
{
    $env = getenv('MAGO_LSP_BINARY_VERSION');
    if (is_string($env) && $env !== '') {
        return ltrim(trim($env), 'v');
    }

    return BINARY_VERSION;
}

/**
 * Maps the current OS and CPU architecture to a Rust target triple.
 *
 * Linux targets use musl for a statically linked binary with no glibc dependency.
 *
 * @throws RuntimeException If the platform has no pre-built binary.
 */
function detect_target(): string
{
    $arch = match (strtolower(php_uname('m'))) {
        'x86_64', 'amd64'  => 'x86_64',
        'aarch64', 'arm64' => 'aarch64',
        'armv7l', 'armv7'  => 'armv7',
        default            => null,
    };

    if ($arch === null) {
        throw new RuntimeException(sprintf(
            'Unsupported architecture: %s. Pre-built binaries are available for x86_64, aarch64, and armv7. '
            . 'Build from source: cargo install mago --features language-server',
            php_uname('m'),
        ));
    }

    $target = match (PHP_OS_FAMILY) {
        'Linux'   => match ($arch) {
            'x86_64'  => 'x86_64-unknown-linux-musl',
            'aarch64' => 'aarch64-unknown-linux-musl',
            'armv7'   => 'armv7-unknown-linux-musleabihf',
            default   => null,
        },
        'Darwin'  => match ($arch) {
            'x86_64'  => 'x86_64-apple-darwin',
            'aarch64' => 'aarch64-apple-darwin',
            default   => null,
        },
        'Windows' => $arch === 'x86_64' ? 'x86_64-pc-windows-msvc' : null,
        'BSD'     => $arch === 'x86_64' ? 'x86_64-unknown-freebsd' : null,
        default   => null,
    };

    if ($target === null) {
        throw new RuntimeException(sprintf(
            'Unsupported platform %s/%s. Build from source: cargo install mago --features language-server',
            PHP_OS_FAMILY,
            php_uname('m'),
        ));
    }

    return $target;
}

/**
 * Returns the archive extension for a given target triple.
 */
function get_archive_extension(string $target): string
{
    return str_contains($target, 'windows-msvc') ? '.zip' : '.tar.gz';
}

/**
 * Builds the GitHub release download URL.
 */
function build_download_url(string $version, string $archiveName): string
{
    return 'https://github.com/' . GITHUB_REPO . '/releases/download/' . $version . '/' . $archiveName;
}

/**
 * Reads a GitHub API token from GITHUB_TOKEN or GH_TOKEN environment variables.
 *
 * @return non-empty-string|null
 */
function get_github_token(): ?string
{
    foreach (['GITHUB_TOKEN', 'GH_TOKEN'] as $var) {
        $value = getenv($var);
        if (is_string($value) && $value !== '') {
            return $value;
        }
    }

    return null;
}

/**
 * Downloads a file, preferring the curl extension and falling back to file_get_contents.
 *
 * @throws RuntimeException If no download method is available or the download fails.
 */
function download(string $url, string $destination): void
{
    if (extension_loaded('curl')) {
        namespace\download_with_curl($url, $destination);
        return;
    }

    if (ini_get('allow_url_fopen')) {
        namespace\download_with_fopen($url, $destination);
        return;
    }

    throw new RuntimeException(
        'Unable to download mago-lsp binary. Install the PHP curl extension or set allow_url_fopen=1 in php.ini.',
    );
}

/**
 * Downloads a file via the curl extension, showing a progress bar to stderr.
 *
 * @throws RuntimeException If the download fails or the server returns a 4xx/5xx status.
 */
function download_with_curl(string $url, string $destination): void
{
    $ch = curl_init($url);
    $fh = fopen($destination, 'w');
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_FILE, $fh);
    curl_setopt($ch, CURLOPT_NOPROGRESS, false);
    curl_setopt($ch, CURLOPT_USERAGENT, 'mago-lsp/' . namespace\get_version());

    $token = namespace\get_github_token();
    if ($token !== null) {
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Authorization: Bearer ' . $token]);
    }

    curl_setopt($ch, CURLOPT_PROGRESSFUNCTION, function (mixed $_ch, int $dlSize, int $dlNow): int {
        if ($dlSize > 0) {
            $pct     = (int) (($dlNow / $dlSize) * 100);
            $dlMb    = number_format($dlNow / 1_048_576, 1);
            $totalMb = number_format($dlSize / 1_048_576, 1);
            fprintf(STDERR, "\r  %s / %s MB (%d%%)", $dlMb, $totalMb, $pct);
        }

        return 0;
    });

    $success    = curl_exec($ch);
    $statusCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error      = curl_error($ch);
    fclose($fh);

    if (!$success || $statusCode >= 400) {
        unlink($destination);
        throw new RuntimeException(
            "Failed to download mago-lsp binary (HTTP {$statusCode}): {$error}\nURL: {$url}",
        );
    }

    fprintf(STDERR, "\n");
}

/**
 * Downloads a file via file_get_contents (requires allow_url_fopen).
 *
 * @throws RuntimeException If the download fails.
 */
function download_with_fopen(string $url, string $destination): void
{
    $headers = ['User-Agent: mago-lsp/' . namespace\get_version()];

    $token = namespace\get_github_token();
    if ($token !== null) {
        $headers[] = 'Authorization: Bearer ' . $token;
    }

    $context  = stream_context_create([
        'http' => [
            'method'          => 'GET',
            'header'          => implode("\r\n", $headers),
            'follow_location' => 1,
            'max_redirects'   => 20,
        ],
    ]);

    $contents = file_get_contents($url, false, $context);
    if ($contents === false) {
        throw new RuntimeException("Failed to download mago-lsp binary.\nURL: {$url}");
    }

    file_put_contents($destination, $contents);
}

/**
 * Executes a closure while holding an exclusive file lock.
 *
 * Blocks until the lock is acquired. The lock file is created if it does not exist.
 * The lock is always released when the closure returns or throws.
 *
 * @template T
 * @param \Closure(): T $callback
 * @return T
 * @throws RuntimeException If the lock file cannot be opened.
 */
function locked(string $lockFile, \Closure $callback): mixed
{
    $handle = fopen($lockFile, 'c');
    if ($handle === false) {
        throw new RuntimeException("Unable to create lock file: {$lockFile}");
    }

    flock($handle, LOCK_EX);

    try {
        return $callback();
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

/**
 * Ensures the mago-lsp binary is present, downloading it on first call.
 *
 * Binaries are cached at $binDir/<version>/mago-lsp[.exe] so repeated calls
 * are a no-op. Uses a file lock to prevent concurrent downloads of the same version.
 *
 * @throws RuntimeException If download or extraction fails.
 * @return string Absolute path to the executable.
 */
function ensure_binary(
    string $version,
    string $target,
    string $executableExtension,
    string $archiveExtension,
    string $binDir,
): string {
    $releaseDir     = $binDir . DIRECTORY_SEPARATOR . $version;
    $executablePath = $releaseDir . DIRECTORY_SEPARATOR . BIN_NAME . $executableExtension;

    if (file_exists($executablePath)) {
        return $executablePath;
    }

    if (!is_dir($releaseDir)) {
        mkdir($releaseDir, 0o755, true);
    }

    $lockFile = $releaseDir . DIRECTORY_SEPARATOR . '.mago-lsp.lock';

    return namespace\locked($lockFile, static function () use (
        $version,
        $target,
        $archiveExtension,
        $executableExtension,
        $releaseDir,
        $executablePath,
    ): string {
        // Double-checked locking: another process may have finished while we waited.
        if (file_exists($executablePath)) {
            return $executablePath;
        }

        $archiveName = 'mago-lsp-' . $version . '-' . $target . $archiveExtension;
        $archiveFile = $releaseDir . DIRECTORY_SEPARATOR . $archiveName;
        $url         = namespace\build_download_url($version, $archiveName);

        fprintf(STDERR, "Downloading mago-lsp %s for %s...\n", $version, $target);
        namespace\download($url, $archiveFile);
        fprintf(STDERR, "Downloaded.\n");

        namespace\extract_binary($archiveFile, $executablePath, $executableExtension, $archiveExtension);

        if (!file_exists($executablePath)) {
            throw new RuntimeException("Expected binary not found after extraction at {$executablePath}");
        }

        if ($executableExtension === '') {
            chmod($executablePath, 0o755);
        }

        return $executablePath;
    });
}

/**
 * Extracts the mago binary from a release archive, writing it to $binDest as mago-lsp.
 *
 * The archive contains the binary named `mago` (or `mago.exe` on Windows) at its root.
 * Supports .zip (Windows) and .tar.gz (all other platforms).
 *
 * @throws RuntimeException If the archive cannot be opened or the binary is not found inside.
 */
function extract_binary(
    string $archive,
    string $binDest,
    string $executableExtension,
    string $archiveExtension,
): void {
    $srcName = 'mago' . $executableExtension;

    if ($archiveExtension === '.zip') {
        if (!class_exists(ZipArchive::class)) {
            unlink($archive);
            throw new RuntimeException('ext-zip is required to extract Windows archives. Install php-zip.');
        }

        $zip = new ZipArchive();
        if ($zip->open($archive) !== true) {
            unlink($archive);
            throw new RuntimeException('Failed to open zip archive: ' . $archive);
        }

        $stream = $zip->getStream($srcName);
        if ($stream === false) {
            $zip->close();
            unlink($archive);
            throw new RuntimeException('Binary "' . $srcName . '" not found in archive');
        }

        file_put_contents($binDest, $stream);
        fclose($stream);
        $zip->close();
        unlink($archive);

        return;
    }

    $tmpDir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'mago-lsp-' . bin2hex(random_bytes(6));
    mkdir($tmpDir, 0o755, true);

    try {
        (new PharData($archive))->extractTo($tmpDir, $srcName, overwrite: true);
        $extracted = $tmpDir . DIRECTORY_SEPARATOR . $srcName;

        if (!is_file($extracted)) {
            throw new RuntimeException('Binary "' . $srcName . '" not found in archive');
        }

        rename($extracted, $binDest);
        unlink($archive);
    } finally {
        $leftover = $tmpDir . DIRECTORY_SEPARATOR . $srcName;
        if (is_file($leftover)) {
            unlink($leftover);
        }

        @rmdir($tmpDir);
    }
}

/**
 * Executes the mago-lsp binary, forwarding stdin/stdout/stderr.
 *
 * On Unix systems, tries pcntl_exec first to replace this process cleanly.
 * Falls back to proc_open on Windows or when pcntl is not available.
 *
 * @param list<string> $args
 * @return never
 */
function execute(string $executablePath, array $args): never
{
    // Replace this process cleanly on Unix (no wrapper overhead for the LSP connection).
    if (function_exists('pcntl_exec')) {
        pcntl_exec($executablePath, $args);
        // Falls through only if pcntl_exec itself fails.
    }

    $command = escapeshellarg($executablePath);
    if ($args !== []) {
        $command .= ' ' . implode(' ', array_map('escapeshellarg', $args));
    }

    $pipes   = [];
    $process = proc_open(
        $command,
        [
            0 => ['file', 'php://stdin', 'r'],
            1 => ['file', 'php://stdout', 'w'],
            2 => ['file', 'php://stderr', 'w'],
        ],
        $pipes,
    );

    if (!is_resource($process)) {
        fwrite(STDERR, "mago-lsp: Unable to start process.\n");
        exit(1);
    }

    do {
        usleep(STATUS_CHECK_INTERVAL);
        $status = proc_get_status($process);
    } while ($status['running']);

    $exitCode = $status['exitcode'];
    if ($status['signaled']) {
        $exitCode = $status['termsig'] + 128;
    }

    proc_close($process);
    exit($exitCode);
}
