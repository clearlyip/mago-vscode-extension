<?php

declare(strict_types=1);

namespace ClearlyIP\MagoLsp;

use Composer\Composer;
use Composer\IO\IOInterface;
use Composer\Plugin\PluginInterface;

use const DIRECTORY_SEPARATOR;
use const PHP_OS_FAMILY;

final class Plugin implements PluginInterface
{
    public function activate(Composer $composer, IOInterface $io): void {}

    public function deactivate(Composer $composer, IOInterface $io): void {}

    /**
     * Removes any legacy binary that older plugin versions placed directly in the Composer bin-dir.
     *
     * Newer installs use a PHP launcher script (plugin/bin/mago-lsp) that Composer manages
     * as a normal bin entry, so no manual cleanup is needed for those.
     */
    public function uninstall(Composer $composer, IOInterface $io): void
    {
        $binDir = (string) $composer->getConfig()->get('bin-dir');
        $ext    = PHP_OS_FAMILY === 'Windows' ? '.exe' : '';

        foreach (['mago-lsp' . $ext, '.mago-lsp-version'] as $file) {
            $path = $binDir . DIRECTORY_SEPARATOR . $file;
            if (is_file($path) && !is_link($path)) {
                unlink($path);
            }
        }
    }
}
