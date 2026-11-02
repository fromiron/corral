"""Restore compact native aliases before comparing with original evaluation labels."""


def restore_recipients(row, result):
    if row['task'] != 'meeting' or not row.get('runtimeView') or result.get('type') != 'result':
        return result
    aliases = result['participantIds']
    mapping = row['runtimeView']['modelToOriginalIds']
    if len(set(aliases)) != len(aliases) or any(alias not in mapping for alias in aliases):
        raise ValueError('native recipients do not match the runtime alias map')
    return {**result, 'modelParticipantIds': aliases, 'participantIds': [mapping[alias] for alias in aliases]}
