#!/bin/sh
PORT=$(( RANDOM % 1000 + 8000 ))
echo "cmd-dbl-click: http://localhost:$PORT/"
ruby -run -e httpd . -p $PORT
