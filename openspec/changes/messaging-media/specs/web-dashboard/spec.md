## MODIFIED Requirements

### Requirement: Conversation view
The dashboard SHALL show recent conversation from the message store, grouped by thread, including each turn's role, timestamp, delivered text, and — for Sunny's turns — the retained private scratch from the stored `UIMessage` payload. It SHALL render message images (inbound and outbound) inline in the thread, served through an authenticated dashboard route (never exposing media without the dashboard's auth gate). It SHALL support keyword search over message history.

#### Scenario: View recent conversation
- **WHEN** the owner opens the conversation page for a thread
- **THEN** recent messages are shown with role and timestamp
- **AND** Sunny's retained scratch (working context not delivered to the user) is viewable alongside its delivered messages

#### Scenario: Message images are shown
- **WHEN** a thread contains a message with an image attachment
- **THEN** the image is rendered inline in the conversation view, served only through the authenticated dashboard route

#### Scenario: Search history
- **WHEN** the owner enters a keyword search
- **THEN** matching past messages are returned
