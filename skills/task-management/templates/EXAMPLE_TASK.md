# Example Task: Modal Help & Settings

This example demonstrates how to apply the task template to an actual task from TODO.md Phase 5.

## [ ] Modal Help & Settings

### Metadata
- **Status**: todo
- **Priority**: high
- **Created**: 2026-03-14
- **Updated**: 2026-03-14
- **Owner**: @developer

### Relationships
- **Parent**: Phase 5: Advanced TUI Features → 🚀 Immediate Priority: UI Polish & UX
- **Dependencies**: [Prompt History](#) (already completed)
- **Blocked By**: None
- **Related Tasks**: [System Notifications](#), [Enhanced Autocomplete](#)

### Goal
Implement modal screens for Help and Settings to show commands and edit configuration without cluttering chat history.

### Requirements
1. Implement `HelpScreen(ModalScreen)` to show available commands and shortcuts
2. Implement `SettingsScreen(ModalScreen)` for viewing/editing client configuration
3. Ensure modals integrate with existing Textual UI framework
4. Maintain keyboard navigation consistency

### Context Files
- `src/acp_client/app.py` - Main application class
- `src/acp_client/ui/` - UI components directory
- `src/acp_client/config.py` - Configuration management
- `pyproject.toml` - Project dependencies and settings

### Artifacts
- Screenshots: `screenshots/modal-help.png`, `screenshots/modal-settings.png`
- Test Results: `tests/test_modals.py` results
- Logs: `logs/ui-modals.log` (if debugging needed)

### Thought Process
#### Hypothesis
Modal screens will provide cleaner UX by separating help/configuration from chat history, reducing visual clutter while maintaining accessibility.

#### Exploration  
1. **Textual Documentation**: ModalScreen API supports `app.push_screen()` and `app.pop_screen()`
2. **Existing Patterns**: Check `app.py` for current screen management (likely uses `Container` widgets)
3. **Configuration System**: `config.py` uses Pydantic settings; need UI to edit these values
4. **Keyboard Shortcuts**: Current key bindings in `app.py`; need to add `F1` for help, `Ctrl+,` for settings

#### Plan
1. Create `HelpScreen` class in `src/acp_client/ui/modals.py`
   - Display command list with descriptions
   - Show keyboard shortcuts
   - Add search/filter capability
2. Create `SettingsScreen` class in same file
   - Display current configuration values
   - Editable fields for common settings
   - Save/load integration with `config.py`
3. Update `App` class in `app.py`
   - Add key bindings for modal triggers
   - Integrate modal push/pop logic
4. Write tests in `tests/test_modals.py`
5. Update documentation in `docs/ui-modals.md`

#### Observations
*[To be filled during implementation]*

#### Decisions
*[To be filled during implementation]*

### Links
- Related PRs: # (to be created)
- Commits: (to be added)
- External References: [Textual ModalScreen Documentation](https://textual.textualize.io/api/screens/#textual.screens.ModalScreen)
