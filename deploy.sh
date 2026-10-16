#!/bin/sh

TAG=test-$(date +'%m.%d.%Y')

git push origin HEAD:refs/tags/$TAG
git push --delete origin $TAG