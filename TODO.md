TODO before 1.0 release:
- ~~display all models below the categories~~
  - ~~make the categories more compact when we do this so they look different from the models~~
- ~~keyword filter (keywords search the name and the tags)~~
- ~~make gcode parser fully bgcode compatible~~
- ~~check gcode for color changes, add number of color changes to metadata~~
- ~~check gcode for batch jobs, add to metadata~~
- ~~check gcode for pauses, add to metadata~~
- filter by maximum print time, ie under an hour, under 25 minutes, etc
- ~~asynchronously try to sync print files from github on launch~~
  - after that, try to sync every 24 hours
  - if there's a failure, try to sync again in 2 minutes, then every 10 minutes until successful
- ~~build as a freestanding app~~
- ~~implement meatpack to fully scan all gcode~~

Version 1.0.0:
- implement Tools menu with Drive Wiper
  - auto-wipes any flash drive on connection, then ejects it
  - notifies user that it is wiped and safe to remove
  - before ejecting, makes sure an empty .Trashes file is created
  - only runs on FAT32 drives
  - for safety, pauses wiping if it goes in the background
    - click to unpause when foregrounded
- ~~Add Profile Cleaner to Tools menu~~
  - deletes all files in ~~Downloads~~, Documents, ~~Desktop~~, etc
  - tells Firefox to quit

Version 2.0:
- Implement adding new prints to database
  - only available to admins, needs github password
    - or maybe a key on a flash drive kept at the desk?
  - GUI for choosing project folder
  - GUI for choosing photos
  - looks at project folder to try to determine original URL of model
    - can prompt user if not found
- Profile Cleaner:
  - also resets Prusaslicer to sensible defaults
  - removes user-saved settings
  - resets Dock?
- new Drive Wiper features:
  - with checkbox set, will reformat to FAT32 or FAT16 if not already in that format
  - with another checkbox set, will reformat anyway
  - another checkbox: "Rename:" with a text field defaulting to "THE SPARK"

Version 2.1:
- Drive Wiper:
  - Add persistant preference for name of makerspace
  - use that for default drive name for "Rename:" field
  - backup drive before wiping so "Unwipe" can be performed?
