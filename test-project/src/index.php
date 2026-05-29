<?php

declare(strict_types=1);

class Greeter
{
    public function __construct(
        private string $name,
    ) {}

    /**
     * Returns a greeting message.
     *
     * @return string The greeting message.
     */
    public function greet(string $f): string
    {
        return "Hello, {$this->name}!";
    }
}

function add(int $a, int $b): int
{
    return $a + $b;
}

$greeter = new Greeter('World');
echo $greeter->greet('f') . PHP_EOL;
echo '2 + 3 = ' . add(2, 3) . PHP_EOL;
