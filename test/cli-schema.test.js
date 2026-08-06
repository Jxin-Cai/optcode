const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { COMMANDS, AUDIENCE_LEVELS, audienceIncludes, buildSchema } = require('../scripts/cli-schema.js');

describe('buildSchema', () => {
  it('workflow returns only workflow-tier commands', () => {
    const schema = buildSchema('workflow');
    assert.equal(schema.command_count, 5);
    assert.ok(schema.commands.every(cmd => cmd.audience === 'workflow'));
  });

  it('advanced returns workflow + advanced commands', () => {
    const schema = buildSchema('advanced');
    const audiences = new Set(schema.commands.map(c => c.audience));
    assert.ok(audiences.has('workflow'));
    assert.ok(audiences.has('advanced'));
    assert.ok(!audiences.has('maintainer'));
    assert.ok(schema.command_count > 5);
  });

  it('maintainer returns all commands', () => {
    const schema = buildSchema('maintainer');
    assert.equal(schema.command_count, COMMANDS.length);
  });

  it('throws for invalid audience', () => {
    assert.throws(() => buildSchema('guest'), /Invalid audience/);
  });
});

describe('audienceIncludes', () => {
  it('workflow includes workflow', () => {
    assert.equal(audienceIncludes('workflow', 'workflow'), true);
  });

  it('advanced does not include workflow', () => {
    assert.equal(audienceIncludes('advanced', 'workflow'), false);
  });

  it('maintainer does not include advanced', () => {
    assert.equal(audienceIncludes('maintainer', 'advanced'), false);
  });

  it('workflow includes maintainer', () => {
    assert.equal(audienceIncludes('workflow', 'maintainer'), true);
  });
});

describe('COMMANDS integrity', () => {
  it('all commands have required fields', () => {
    for (const cmd of COMMANDS) {
      assert.ok(cmd.name, `command missing name`);
      assert.ok(cmd.script, `${cmd.name} missing script`);
      assert.ok(cmd.description, `${cmd.name} missing description`);
      assert.ok(cmd.audience, `${cmd.name} missing audience`);
      assert.ok(AUDIENCE_LEVELS[cmd.audience], `${cmd.name} has invalid audience: ${cmd.audience}`);
    }
  });
});

describe('schema output structure', () => {
  it('has correct top-level fields', () => {
    const schema = buildSchema('workflow');
    assert.equal(schema.schema, 'opencli');
    assert.equal(schema.version, 1);
    assert.equal(schema.plugin, 'optcode');
    assert.equal(schema.audience, 'workflow');
    assert.ok(Array.isArray(schema.commands));
    assert.equal(typeof schema.command_count, 'number');
  });
});
