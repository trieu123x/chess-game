# Build context la thu muc source/ (can common-java de build server)
# syntax: multi-stage - build bang Maven, chay bang JRE cho nhe

FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /build
# Copy pom truoc de tan dung cache layer khi chi doi code
COPY pom.xml ./
COPY common-java/pom.xml common-java/
COPY server/pom.xml server/
COPY client-cli/pom.xml client-cli/
RUN mvn -B -pl common-java,server -am dependency:go-offline -DskipTests || true
COPY common-java/src common-java/src
COPY server/src server/src
RUN mvn -B -pl common-java,server -am package -DskipTests

FROM eclipse-temurin:17-jre
WORKDIR /app
RUN useradd --system --uid 10001 dcgs
COPY --from=build /build/server/target/dcgs-server.jar /app/dcgs-server.jar
COPY server/config.properties /app/config.properties
USER dcgs
EXPOSE 5555
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/dcgs-server.jar"]
CMD ["--config", "/app/config.properties"]
