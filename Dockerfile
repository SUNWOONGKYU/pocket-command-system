# Pocket Command Supporting System — 설명 문서 정적 서빙 (Cloudtype / 모든 컨테이너 PaaS 공용)
# docs/ (index.html + diagrams/*.svg) 를 nginx로 그대로 서빙한다. 빌드 단계 없음.
FROM nginx:alpine
COPY docs/ /usr/share/nginx/html/
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
