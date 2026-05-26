<?php

declare(strict_types=1);

namespace ClearlyIP\MagoLsp;

use Composer\Composer;
use Composer\IO\IOInterface;
use Composer\Util\HttpDownloader;
use PharData;
use RuntimeException;
use ZipArchive;

final class Installer
{
    /**
     * The name used for the installed binary in the Composer bin directory.
     * Named mago-lsp rather than mago to avoid conflicts with a separately
     * installed standard mago binary.
     */
    public const BIN_NAME = 'mago-lsp';

    /**
     * GitHub repository that publishes the LSP-enabled release archives.
     * Format: {owner}/{repo}
     */
    private const GITHUB_REPO = 'clearlyip/mago-vscode-extension';

    /**
     * @param IOInterface $io       Composer IO interface used for progress and error output.
     * @param Composer    $composer The active Composer instance, used to resolve configuration
     *                             and the local package repository.
     */
    public function __construct(
        private readonly IOInterface $io,
        private readonly Composer $composer,
    ) {}

    /**
     * Downloads and installs the mago-lsp binary for the current platform.
     *
     * Resolves the package version from the Composer local repository, maps the
     * current OS and CPU architecture to a release target triple, then downloads
     * the matching archive from GitHub Releases and extracts the binary into the
     * Composer bin directory as `mago-lsp` (or `mago-lsp.exe` on Windows).
     *
     * Skips the download if the binary is already present and the `.mago-lsp-version`
     * sentinel file records the same version, making repeated `composer install`
     * calls effectively a no-op.
     *
     * @throws RuntimeException If the archive cannot be opened or the binary is
     *                          not found inside it.
     */
    public function install(): void
    {
        $version = $this->resolveVersion();

        if ($version === null) {
            $this->io->writeError('<warning>mago-lsp: could not resolve package version, skipping binary install</warning>');
            return;
        }

        $target = $this->detectTarget();

        if ($target === null) {
            $this->io->writeError(sprintf(
                '<warning>mago-lsp: unsupported platform %s/%s — skipping binary install. '
                . 'Build from source: cargo install mago --features language-server</warning>',
                PHP_OS_FAMILY,
                php_uname('m'),
            ));
            return;
        }

        $binDir      = (string) $this->composer->getConfig()->get('bin-dir');
        $ext         = PHP_OS_FAMILY === 'Windows' ? '.exe' : '';
        $binPath     = $binDir . DIRECTORY_SEPARATOR . self::BIN_NAME . $ext;
        $versionFile = $binDir . DIRECTORY_SEPARATOR . '.mago-lsp-version';

        if (is_file($binPath) && is_file($versionFile) && trim((string) file_get_contents($versionFile)) === $version) {
            $this->io->write('<info>mago-lsp: ' . $version . ' already installed at ' . $binPath . '</info>');
            return;
        }

        $pkgExt      = str_contains($target, 'windows-msvc') ? '.zip' : '.tar.gz';
        $archiveName = 'mago-lsp-' . $version . '-' . $target . $pkgExt;
        $url         = 'https://github.com/' . self::GITHUB_REPO . '/releases/download/' . $version . '/' . $archiveName;
        $tmpPath     = sys_get_temp_dir() . DIRECTORY_SEPARATOR . $archiveName;

        $this->io->write('<info>mago-lsp: downloading ' . $version . ' for ' . $target . '</info>');

        try {
            $this->download($url, $tmpPath);

            if (!is_dir($binDir)) {
                mkdir($binDir, 0755, true);
            }

            $this->extract($tmpPath, $binPath, $pkgExt);

            if (PHP_OS_FAMILY !== 'Windows') {
                chmod($binPath, 0755);
            }

            file_put_contents($versionFile, $version);
            $this->io->write('<info>mago-lsp: installed at ' . $binPath . '</info>');
        } finally {
            if (is_file($tmpPath)) {
                unlink($tmpPath);
            }
        }
    }

    /**
     * Resolves the installed version of this package from Composer's local repository.
     *
     * The version string is stripped of a leading `v` prefix so it matches the
     * bare semver used in GitHub release tag names (e.g. `1.29.0` not `v1.29.0`).
     *
     * @return string|null The resolved version, or null if the package is not found
     *                     in the local repository (e.g. running outside Composer context).
     */
    private function resolveVersion(): ?string
    {
        $local = $this->composer->getRepositoryManager()->getLocalRepository();

        foreach ($local->getPackages() as $package) {
            if ($package->getName() === 'clearlyip/mago-lsp') {
                return ltrim($package->getPrettyVersion(), 'v');
            }
        }

        return null;
    }

    /**
     * Maps the current OS and CPU architecture to a Rust target triple.
     *
     * Linux targets use musl rather than glibc so the binary is statically
     * linked and has no minimum glibc version requirement.
     *
     * @return string|null A target triple such as `x86_64-unknown-linux-musl`,
     *                     or null if the current platform is not supported.
     */
    private function detectTarget(): ?string
    {
        $arch = match (strtolower(php_uname('m'))) {
            'x86_64', 'amd64'  => 'x86_64',
            'aarch64', 'arm64' => 'aarch64',
            'armv7l', 'armv7'  => 'armv7',
            default            => null,
        };

        if ($arch === null) {
            return null;
        }

        // Prefer musl on Linux: statically linked, no glibc version dependency.
        return match (PHP_OS_FAMILY) {
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
    }

    /**
     * Downloads a file from the given URL and writes it to a local path.
     *
     * Uses Composer's {@see HttpDownloader} so that proxy settings, authentication
     * credentials, and retry logic configured in the project's Composer config are
     * all respected automatically.
     *
     * @param string $url  The URL to fetch.
     * @param string $dest Absolute path to write the downloaded content to.
     */
    private function download(string $url, string $dest): void
    {
        $downloader = new HttpDownloader($this->io, $this->composer->getConfig());
        $response   = $downloader->get($url);
        file_put_contents($dest, $response->getBody());
    }

    /**
     * Extracts the mago binary from a release archive and writes it to the destination path.
     *
     * The GitHub Actions workflow packages the binary as `mago` (or `mago.exe` on Windows)
     * at the root of each archive. This method reads that entry and writes it to
     * `$binDest` under the `mago-lsp` name.
     *
     * Supports two archive formats:
     * - `.zip` — used for Windows MSVC targets; extracted via {@see ZipArchive}.
     * - `.tar.gz` — used for all other targets; extracted via {@see PharData} so
     *   there is no dependency on shell utilities such as `tar`.
     *
     * @param string $archive  Absolute path to the downloaded archive file.
     * @param string $binDest  Absolute path where the binary should be written.
     * @param string $ext      Archive extension, either `.zip` or `.tar.gz`.
     *
     * @throws RuntimeException If the archive cannot be opened or the binary entry
     *                          is not found inside it.
     */
    private function extract(string $archive, string $binDest, string $ext): void
    {
        $srcName = 'mago' . (PHP_OS_FAMILY === 'Windows' ? '.exe' : '');

        if ($ext === '.zip') {
            $zip = new ZipArchive();

            if ($zip->open($archive) !== true) {
                throw new RuntimeException('mago-lsp: failed to open zip archive: ' . $archive);
            }

            $stream = $zip->getStream($srcName);

            if ($stream === false) {
                $zip->close();
                throw new RuntimeException('mago-lsp: binary "' . $srcName . '" not found in archive');
            }

            file_put_contents($binDest, $stream);
            fclose($stream);
            $zip->close();

            return;
        }

        // .tar.gz — use PharData so we have no shell dependency
        $tmpDir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'mago-lsp-' . bin2hex(random_bytes(6));
        mkdir($tmpDir, 0755, true);

        try {
            (new PharData($archive))->extractTo($tmpDir, $srcName, overwrite: true);
            $extracted = $tmpDir . DIRECTORY_SEPARATOR . $srcName;

            if (!is_file($extracted)) {
                throw new RuntimeException('mago-lsp: binary "' . $srcName . '" not found in archive');
            }

            rename($extracted, $binDest);
        } finally {
            $leftover = $tmpDir . DIRECTORY_SEPARATOR . $srcName;
            if (is_file($leftover)) {
                unlink($leftover);
            }

            @rmdir($tmpDir);
        }
    }
}
